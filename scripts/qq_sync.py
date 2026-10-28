"""Read-only bridge from QQ NT's local SQLCipher database to CHAOS.

Only sqlcipher3 is required. QQ stores nt_msg.db with a 1024-byte custom header
followed by SQLCipher 4 data. QQ 9.9.x uses HMAC-SHA512 for page authentication.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

try:
    import sqlcipher3
except ImportError:  # pragma: no cover - reported through the CLI
    sqlcipher3 = None

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HEADER_SIZE = 1024
PAGE_SIZE = 4096
KDF_ITER = 4000


def fail(message: str) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False))
    raise SystemExit(1)


def resolve_db_dir(value: str) -> Path:
    root = Path(value).expanduser()
    for candidate in (root, root / "nt_db", root / "nt_qq" / "nt_db"):
        if (candidate / "nt_msg.db").is_file():
            return candidate.resolve()
    fail(f"未找到 nt_msg.db：{root}")


def copy_without_header(source: Path, target: Path) -> None:
    with source.open("rb") as reader:
        reader.seek(HEADER_SIZE)
        with target.open("wb") as writer:
            shutil.copyfileobj(reader, writer, 64 << 20)


def open_database(path: Path, key: str, cache_dir: Path | None = None):
    if cache_dir is None:
        cleanup = Path(tempfile.mkdtemp(prefix="chaos-qq-"))
        database = cleanup / path.name
        for suffix in ("", "-wal", "-shm"):
            source = Path(str(path) + suffix)
            if source.is_file():
                shutil.copy2(source, str(database) + suffix)
        stripped = cleanup / (path.name + ".stripped")
        copy_without_header(database, stripped)
        os.replace(stripped, database)
    else:
        cache_dir.mkdir(parents=True, exist_ok=True)
        database = cache_dir / path.name
        meta_path = cache_dir / (path.name + ".json")
        source_stat = path.stat()
        meta = {}
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text("utf-8"))
            except Exception:
                meta = {}
        reuse = (
            database.is_file()
            and meta.get("size") == source_stat.st_size
            and meta.get("mtime") == source_stat.st_mtime_ns
        )
        if not reuse:
            for target in cache_dir.glob(path.name + "*"):
                try:
                    target.unlink()
                except OSError:
                    pass
            shutil.copy2(path, database)
            stripped = cache_dir / (path.name + ".stripped")
            copy_without_header(database, stripped)
            os.replace(stripped, database)
            meta_path.write_text(
                json.dumps({"size": source_stat.st_size, "mtime": source_stat.st_mtime_ns}),
                "utf-8",
            )
        for suffix in ("-wal", "-shm"):
            source = Path(str(path) + suffix)
            target = Path(str(database) + suffix)
            if source.is_file():
                try:
                    shutil.copy2(source, target)
                except OSError:
                    pass
            elif target.exists():
                try:
                    target.unlink()
                except OSError:
                    pass
        cleanup = None
    connection = sqlcipher3.connect(database)
    cursor = connection.cursor()
    cursor.execute("PRAGMA cipher_log_level = NONE")
    cursor.execute(f"PRAGMA cipher_page_size = {PAGE_SIZE}")
    cursor.execute("PRAGMA key = '" + key.replace("'", "''") + "'")
    cursor.execute(f"PRAGMA kdf_iter = {KDF_ITER}")
    cursor.execute("PRAGMA cipher_hmac_algorithm = HMAC_SHA512")
    cursor.execute("PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512")
    cursor.execute("SELECT count(*) FROM sqlite_master").fetchone()
    return connection, cleanup


def open_nt(db_path: Path, key: str, cache_dir: Path | None = None):
    if sqlcipher3 is None:
        fail("缺少 sqlcipher3，请在用于同步的 Python 中执行 pip install sqlcipher3")
    return open_database(db_path, key, cache_dir)


def read_varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while position < len(data):
        byte = data[position]
        position += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, position
        shift += 7
        if shift > 63:
            break
    raise ValueError("truncated varint")


def text_from_blob(blob: bytes) -> str:
    """Extract field 45101 (text segments) from QQ's MsgBody protobuf."""
    texts: list[str] = []

    def walk(data: bytes, depth: int) -> None:
        position = 0
        while position < len(data):
            try:
                key, position = read_varint(data, position)
            except ValueError:
                return
            field = key >> 3
            wire = key & 7
            if wire == 0:
                try:
                    _, position = read_varint(data, position)
                except ValueError:
                    return
            elif wire == 2:
                try:
                    length, position = read_varint(data, position)
                except ValueError:
                    return
                if position + length > len(data):
                    return
                payload = data[position : position + length]
                position += length
                if field == 45101:
                    value = payload.decode("utf-8", "replace").strip()
                    if value:
                        texts.append(value)
                elif depth < 2 and payload:
                    walk(payload, depth + 1)
            elif wire == 1:
                position += 8
            elif wire == 5:
                position += 4
            else:
                return

    try:
        walk(blob, 0)
    except Exception:
        pass
    return "\n".join(texts).strip()[:12000]


def groups(path: Path, key: str, cache_dir: Path | None = None) -> dict:
    connection, cleanup = open_nt(path / "group_info.db", key, cache_dir)
    try:
        cursor = connection.cursor()
        rows = cursor.execute(
            'SELECT "60001", "60007" FROM group_list '
            'WHERE "60007" IS NOT NULL AND "60007" != \'\' ORDER BY "60007"'
        ).fetchall()
        return {
            "groups": [
                {"id": str(group_id), "name": name}
                for group_id, name in rows
                if group_id is not None and name
            ]
        }
    finally:
        connection.close()
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


def test(path: Path, key: str, cache_dir: Path | None = None) -> dict:
    connection, cleanup = open_nt(path / "nt_msg.db", key, cache_dir)
    try:
        cursor = connection.cursor()
        group_count = cursor.execute('SELECT COUNT(*) FROM group_msg_table').fetchone()[0]
        private_count = cursor.execute('SELECT COUNT(*) FROM c2c_msg_table').fetchone()[0]
        try:
            latest_row = cursor.execute(
                'SELECT "40050" FROM group_msg_table ORDER BY "40001" DESC LIMIT 1'
            ).fetchone()
            latest = latest_row[0] if latest_row else None
        except Exception:
            latest = None
        return {
            "ok": True,
            "groupMessages": group_count,
            "privateMessages": private_count,
            "latest": latest,
        }
    finally:
        connection.close()
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


def range_messages(
    args: argparse.Namespace, path: Path, key: str, cache_dir: Path | None = None
) -> dict:
    connection, cleanup = open_nt(path / "nt_msg.db", key, cache_dir)
    try:
        cursor = connection.cursor()
        uid_map = {
            uid: qq
            for uid, qq in cursor.execute(
                'SELECT "48902", "1002" FROM nt_uid_mapping_table'
            ).fetchall()
            if uid and qq
        }
        if args.private:
            reverse: dict[str, str] = {}
            for uid, qq in uid_map.items():
                key = str(qq)
                if not key:
                    continue
                if key not in reverse or str(uid).startswith("u_"):
                    reverse[key] = uid
            peer = reverse.get(str(args.private))
            if not peer:
                fail(f"找不到私聊对象 {args.private}")
            table = "c2c_msg_table"
        else:
            if not args.group:
                fail("缺少群号")
            peer = args.group
            table = "group_msg_table"
        lower = args.since_time or 0
        upper = args.until_time or int(time.time())
        try:
            rows = cursor.execute(
                f"""
                SELECT rowid, "40001", "40050", "40020", "40033",
                       "40021", "40030", "40013", "40093", "40800"
                FROM {table}
                WHERE "40021" = ? AND "40050" >= ? AND "40050" <= ?
                ORDER BY "40050" ASC
                LIMIT 400
                """,
                (peer, lower, upper),
            ).fetchall()
        except Exception as error:
            fail(f"按时间读取失败：{error}")
        items: list[dict] = []
        for row in rows:
            (
                rowid,
                message_id,
                timestamp,
                sender_uid,
                sender_qq,
                chat_id,
                chat_qq,
                direction,
                nickname,
                blob,
            ) = row
            sender_qq = sender_qq or uid_map.get(sender_uid)
            is_self = bool(args.self_qq and str(sender_qq or "") == args.self_qq)
            if is_self and not args.include_self:
                continue
            if not is_self and direction not in (0, 3):
                continue
            text = text_from_blob(blob or b"")
            if not text:
                continue
            if args.private:
                chat_id = args.private
                chat_qq = args.private
            items.append(
                {
                    "id": str(message_id),
                    "rowid": str(rowid),
                    "time": int(timestamp or 0),
                    "sender": nickname or (str(sender_qq) if sender_qq else sender_uid) or "QQ",
                    "senderId": str(sender_qq or ""),
                    "groupId": str(chat_id or peer),
                    "groupQQ": str(chat_qq or ""),
                    "text": text,
                    "atAll": (not args.private)
                    and ("@全体成员" in text or "全体成员" in text),
                    "atMe": False,
                    "fromSelf": is_self,
                }
            )
            if len(items) >= max(1, min(args.limit, 200)):
                break
        return {"messages": items}
    finally:
        connection.close()
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


def messages(
    args: argparse.Namespace, path: Path, key: str, cache_dir: Path | None = None
) -> dict:
    connection, cleanup = open_nt(path / "nt_msg.db", key, cache_dir)
    try:
        cursor = connection.cursor()
        max_rowid = cursor.execute("SELECT max(rowid) FROM group_msg_table").fetchone()[0] or 0
        cutoff = int(time.time()) - max(1, args.since_days) * 86400
        window_ms = (max(1, args.since_days) + 1) * 86400 * 1000
        start = args.after_rowid or max(0, int(max_rowid) - window_ms * (1 << 22))
        lowest_time = args.after_time - 300 if args.after_time else cutoff
        collected: dict[str, dict] = {}
        last_rowid = start
        last_time = args.after_time
        skipped = 0
        limit = max(1, min(args.limit, 200))
        uid_map = {
            uid: qq
            for uid, qq in cursor.execute(
                'SELECT "48902", "1002" FROM nt_uid_mapping_table'
            ).fetchall()
            if uid and qq
        }

        def consider(row) -> None:
            nonlocal last_rowid, last_time
            (
                rowid,
                message_id,
                timestamp,
                sender_uid,
                sender_qq,
                group_id,
                group_qq,
                direction,
                nickname,
                blob,
            ) = row
            last_rowid = max(last_rowid, int(rowid))
            last_time = max(last_time, int(timestamp or 0))
            if int(timestamp or 0) < lowest_time:
                return
            sender_qq = sender_qq or uid_map.get(sender_uid)
            is_self = bool(args.self_qq and str(sender_qq or "") == args.self_qq)
            if is_self and not args.include_self:
                return
            if not is_self and direction not in (0, 3):
                return
            text = text_from_blob(blob or b"")
            if not text:
                return
            message_key = str(message_id)
            if message_key in collected:
                return
            collected[message_key] = {
                "id": message_key,
                "rowid": str(rowid),
                "time": int(timestamp or 0),
                "sender": nickname or (str(sender_qq) if sender_qq else sender_uid) or "QQ",
                "senderId": str(sender_qq or ""),
                "groupId": str(group_id or args.group),
                "groupQQ": str(group_qq or ""),
                "text": text,
                "atAll": "@全体成员" in text or "全体成员" in text,
                "fromSelf": is_self,
            }

        # Pass 1: rows after the rowid cursor (normal new messages).
        while len(collected) < limit:
            try:
                rows = cursor.execute(
                    """
                    SELECT rowid, "40001", "40050", "40020", "40033",
                           "40021", "40030", "40013", "40093", "40800"
                    FROM group_msg_table
                    WHERE rowid > ? AND "40021" = ?
                    ORDER BY rowid ASC
                    LIMIT 200
                    """,
                    (last_rowid, args.group),
                ).fetchall()
            except Exception:
                skipped += 1
                if skipped > 2000:
                    raise
                last_rowid += 1
                continue
            if not rows:
                break
            for row in rows:
                consider(row)
                if len(collected) >= limit:
                    break
            if len(rows) < 200:
                break

        # Pass 2: messages whose timestamp is newer than the cursor but whose
        # rowid is lower (QQ sometimes inserts locally-generated rows this way).
        if len(collected) < limit:
            try:
                time_rows = cursor.execute(
                    """
                    SELECT rowid, "40001", "40050", "40020", "40033",
                           "40021", "40030", "40013", "40093", "40800"
                    FROM group_msg_table
                    WHERE "40021" = ? AND "40050" >= ?
                    ORDER BY "40050" ASC
                    LIMIT 400
                    """,
                    (args.group, lowest_time),
                ).fetchall()
            except Exception:
                time_rows = []
            for row in time_rows:
                consider(row)
                if len(collected) >= limit:
                    break

        items = sorted(collected.values(), key=lambda item: (item["time"], int(item["rowid"])))[:limit]
        if items:
            ids = [int(item["id"]) for item in items]
            placeholders = ",".join("?" for _ in ids)
            at_me_rows = cursor.execute(
                f'SELECT "40001" FROM group_at_me_msg '
                f'WHERE "40027" = ? AND "40001" IN ({placeholders})',
                [int(args.group), *ids],
            ).fetchall()
            at_me = {str(row[0]) for row in at_me_rows}
            for item in items:
                item["atMe"] = item["id"] in at_me
        return {
            "messages": items,
            "next": {
                "afterRowid": str(last_rowid),
                "afterTime": last_time,
                "afterId": items[-1]["id"] if items else (str(args.after_id or "0")),
            },
        }
    finally:
        connection.close()
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["test", "groups", "messages"])
    parser.add_argument("--db-dir", required=True)
    parser.add_argument("--group", default="")
    parser.add_argument("--private", default="")
    parser.add_argument("--after-time", type=int, default=0)
    parser.add_argument("--after-id", default="0")
    parser.add_argument("--after-rowid", type=int, default=0)
    parser.add_argument("--since-time", type=int, default=0)
    parser.add_argument("--until-time", type=int, default=0)
    parser.add_argument("--self-qq", default="")
    parser.add_argument("--include-self", action="store_true")
    parser.add_argument("--since-days", type=int, default=3)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--cache-dir", default="")
    args = parser.parse_args()
    key = os.environ.get("QQ_DB_KEY", "").strip()
    if not key:
        fail("缺少 QQ_DB_KEY")
    path = resolve_db_dir(args.db_dir)
    cache = Path(args.cache_dir).expanduser() if args.cache_dir else None
    try:
        if args.command == "test":
            result = test(path, key, cache)
        elif args.command == "groups":
            result = groups(path, key, cache)
        else:
            if args.since_time:
                result = range_messages(args, path, key, cache)
            else:
                if not args.group:
                    fail("缺少群号")
                result = messages(args, path, key, cache)
        print(json.dumps(result, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as error:  # pragma: no cover - surfaced to the app
        fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
