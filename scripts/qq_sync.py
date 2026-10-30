"""Read-only bridge from QQ NT's local SQLCipher database to CHAOS.

Only sqlcipher3 is required. QQ stores nt_msg.db with a 1024-byte custom header
followed by SQLCipher data. QQ 9.9.36 keeps the page HMAC algorithm in that
header ("HMAC_SHA1" in the DB format 1.1.0.1), while the key derivation still
uses PBKDF2-HMAC-SHA512 with 4000 iterations.
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
DEFAULT_PROFILE = {
    "headerSize": HEADER_SIZE,
    "pageSize": PAGE_SIZE,
    "kdfIter": KDF_ITER,
    "hmac": "HMAC_SHA512",
    "kdf": "PBKDF2_HMAC_SHA512",
}
HEADER_HMAC_MARKERS = (
    (b"HMAC_SHA512", "HMAC_SHA512"),
    (b"HMAC_SHA256", "HMAC_SHA256"),
    (b"HMAC_SHA1", "HMAC_SHA1"),
)


def hmac_from_header(path: Path) -> str | None:
    """QQ writes the page HMAC algorithm into its custom 1024-byte header."""
    try:
        with path.open("rb") as reader:
            header = reader.read(HEADER_SIZE)
    except OSError:
        return None
    for marker, name in HEADER_HMAC_MARKERS:
        if marker in header:
            return name
    return None


def load_profile(cache_dir: Path | None) -> dict:
    path = None
    if os.environ.get("QQ_DB_PROFILE"):
        path = Path(os.environ["QQ_DB_PROFILE"]).expanduser()
    elif cache_dir is not None:
        path = cache_dir / "qq-profile.json"
    if path is None or not path.is_file():
        return DEFAULT_PROFILE
    try:
        data = json.loads(path.read_text("utf-8"))
        header = int(data.get("headerSize", HEADER_SIZE))
        page = int(data.get("pageSize", PAGE_SIZE))
        kdf_iter = int(data.get("kdfIter", KDF_ITER))
        hmac = str(data.get("hmac", "HMAC_SHA512"))
        kdf = str(data.get("kdf", "PBKDF2_HMAC_SHA512"))
        if header not in (0, 512, 1024, 2048, 4096):
            header = HEADER_SIZE
        if page not in (1024, 2048, 4096, 8192):
            page = PAGE_SIZE
        if kdf_iter < 1 or kdf_iter > 1000000:
            kdf_iter = KDF_ITER
        if hmac not in ("HMAC_SHA512", "HMAC_SHA256"):
            hmac = "HMAC_SHA512"
        if kdf not in ("PBKDF2_HMAC_SHA512", "PBKDF2_HMAC_SHA256"):
            kdf = "PBKDF2_HMAC_SHA512"
        return {
            "headerSize": header,
            "pageSize": page,
            "kdfIter": kdf_iter,
            "hmac": hmac,
            "kdf": kdf,
        }
    except Exception:
        return DEFAULT_PROFILE


def fail(message: str) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False))
    raise SystemExit(1)


def resolve_db_dir(value: str) -> Path:
    root = Path(value).expanduser()
    for candidate in (root, root / "nt_db", root / "nt_qq" / "nt_db"):
        if (candidate / "nt_msg.db").is_file():
            return candidate.resolve()
    fail(f"未找到 nt_msg.db：{root}")


def copy_without_header(source: Path, target: Path, header: int = HEADER_SIZE) -> None:
    with source.open("rb") as reader:
        reader.seek(header)
        with target.open("wb") as writer:
            shutil.copyfileobj(reader, writer, 64 << 20)


def open_database(path: Path, key: str, cache_dir: Path | None = None):
    profile = load_profile(cache_dir)
    header_hmac = hmac_from_header(path)
    if header_hmac and header_hmac != profile["hmac"]:
        # QQ 9.9.36 的头部写着 HMAC_SHA1；页面 HMAC 必须以头部为准，
        # 否则密钥正确也会被判为 "file is not a database"。
        profile = dict(profile)
        profile["hmac"] = header_hmac
    if cache_dir is None:
        cleanup = Path(tempfile.mkdtemp(prefix="chaos-qq-"))
        database = cleanup / path.name
        for suffix in ("", "-wal", "-shm"):
            source = Path(str(path) + suffix)
            if source.is_file():
                shutil.copy2(source, str(database) + suffix)
        stripped = cleanup / (path.name + ".stripped")
        copy_without_header(database, stripped, profile["headerSize"])
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
            and meta.get("header") == profile["headerSize"]
        )
        if not reuse:
            for target in cache_dir.glob(path.name + "*"):
                try:
                    target.unlink()
                except OSError:
                    pass
            shutil.copy2(path, database)
            stripped = cache_dir / (path.name + ".stripped")
            copy_without_header(database, stripped, profile["headerSize"])
            os.replace(stripped, database)
            meta_path.write_text(
                json.dumps(
                    {
                        "size": source_stat.st_size,
                        "mtime": source_stat.st_mtime_ns,
                        "header": profile["headerSize"],
                    }
                ),
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
    cursor.execute(f"PRAGMA cipher_page_size = {profile['pageSize']}")
    cursor.execute("PRAGMA key = '" + key.replace("'", "''") + "'")
    cursor.execute(f"PRAGMA kdf_iter = {profile['kdfIter']}")
    cursor.execute(f"PRAGMA cipher_hmac_algorithm = {profile['hmac']}")
    cursor.execute(f"PRAGMA cipher_kdf_algorithm = {profile['kdf']}")
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


def contacts(path: Path, key: str, cache_dir: Path | None = None) -> dict:
    recent: dict[str, int] = {}
    connection, cleanup = open_nt(path / "nt_msg.db", key, cache_dir)
    try:
        cursor = connection.cursor()
        rows = None
        for table in ("recent_contact_v3_table", "recent_contact_table"):
            try:
                rows = cursor.execute(
                    f'SELECT "40030", "40050" FROM "{table}" '
                    f'WHERE "40030" IS NOT NULL AND "40030" != 0'
                ).fetchall()
                break
            except Exception:
                continue
        for qq, last_time in rows or []:
            qq_text = str(qq or "").strip()
            if qq_text.isdigit():
                recent[qq_text] = max(recent.get(qq_text, 0), int(last_time or 0))
    finally:
        connection.close()
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)

    profile: dict[str, dict[str, str]] = {}
    friends: set[str] = set()
    profile_connection = None
    profile_cleanup = None
    profile_path = path / "profile_info.db"
    if profile_path.is_file():
        try:
            profile_connection, profile_cleanup = open_nt(profile_path, key, cache_dir)
            cursor = profile_connection.cursor()
            try:
                for qq, nickname, remark in cursor.execute(
                    'SELECT "1002", "20002", "20009" FROM profile_info_v6'
                ).fetchall():
                    qq_text = str(qq or "").strip()
                    if qq_text.isdigit():
                        profile[qq_text] = {
                            "name": str(nickname or "").strip(),
                            "remark": str(remark or "").strip(),
                        }
                for uid, qq in cursor.execute('SELECT "1000", "1002" FROM buddy_list').fetchall():
                    qq_text = str(qq or "").strip()
                    if qq_text.isdigit():
                        friends.add(qq_text)
            except Exception:
                pass
        finally:
            if profile_connection is not None:
                profile_connection.close()
            if profile_cleanup:
                shutil.rmtree(profile_cleanup, ignore_errors=True)

    contacts_by_qq: dict[str, dict] = {}
    for qq_text in friends | set(recent):
        item = profile.get(qq_text, {})
        name_text = item.get("name", "").strip()
        remark_text = item.get("remark", "").strip()
        contacts_by_qq[qq_text] = {
            "id": qq_text,
            "name": name_text or remark_text or qq_text,
            "remark": remark_text,
            "lastTime": recent.get(qq_text, 0),
        }
    items = sorted(
        contacts_by_qq.values(),
        key=lambda item: (-item["lastTime"], item["name"], item["id"]),
    )
    for item in items:
        item.pop("lastTime", None)
    return {"contacts": items}


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
                    "atMe": bool(args.private) and not is_self,
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
        uid_map = {
            uid: qq
            for uid, qq in cursor.execute(
                'SELECT "48902", "1002" FROM nt_uid_mapping_table'
            ).fetchall()
            if uid and qq
        }
        private = bool(args.private)
        if private:
            reverse: dict[str, str] = {}
            for uid, qq in uid_map.items():
                qq_key = str(qq)
                if not qq_key:
                    continue
                if qq_key not in reverse or str(uid).startswith("u_"):
                    reverse[qq_key] = uid
            peer = reverse.get(str(args.private))
            if not peer:
                fail(f"找不到私聊对象 {args.private}")
            table = "c2c_msg_table"
        else:
            if not args.group:
                fail("缺少群号")
            peer = args.group
            table = "group_msg_table"
        max_rowid = cursor.execute(f"SELECT max(rowid) FROM {table}").fetchone()[0] or 0
        cutoff = int(time.time()) - max(1, args.since_days) * 86400
        window_ms = (max(1, args.since_days) + 1) * 86400 * 1000
        start = args.after_rowid or max(0, int(max_rowid) - window_ms * (1 << 22))
        lowest_time = args.after_time - 300 if args.after_time else cutoff
        collected: dict[str, dict] = {}
        last_rowid = start
        last_time = args.after_time
        skipped = 0
        limit = max(1, min(args.limit, 200))

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
            chat_key = args.private if private else (group_id or args.group)
            chat_qq = args.private if private else group_qq
            collected[message_key] = {
                "id": message_key,
                "rowid": str(rowid),
                "time": int(timestamp or 0),
                "sender": nickname or (str(sender_qq) if sender_qq else sender_uid) or "QQ",
                "senderId": str(sender_qq or ""),
                "groupId": str(chat_key or ""),
                "groupQQ": str(chat_qq or ""),
                "text": text,
                "atAll": (not private) and ("@全体成员" in text or "全体成员" in text),
                "atMe": private and not is_self,
                "fromSelf": is_self,
            }

        # Pass 1: rows after the rowid cursor (normal new messages).
        while len(collected) < limit:
            try:
                rows = cursor.execute(
                    f"""
                    SELECT rowid, "40001", "40050", "40020", "40033",
                           "40021", "40030", "40013", "40093", "40800"
                    FROM {table}
                    WHERE rowid > ? AND "40021" = ?
                    ORDER BY rowid ASC
                    LIMIT 200
                    """,
                    (last_rowid, peer),
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
                    f"""
                    SELECT rowid, "40001", "40050", "40020", "40033",
                           "40021", "40030", "40013", "40093", "40800"
                    FROM {table}
                    WHERE "40021" = ? AND "40050" >= ?
                    ORDER BY "40050" ASC
                    LIMIT 400
                    """,
                    (peer, lowest_time),
                ).fetchall()
            except Exception:
                time_rows = []
            for row in time_rows:
                consider(row)
                if len(collected) >= limit:
                    break

        items = sorted(collected.values(), key=lambda item: (item["time"], int(item["rowid"])))[:limit]
        if items and not private:
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
    parser.add_argument("command", choices=["test", "groups", "contacts", "messages"])
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
        elif args.command == "contacts":
            result = contacts(path, key, cache)
        else:
            if args.since_time:
                result = range_messages(args, path, key, cache)
            else:
                if not args.group and not args.private:
                    fail("缺少群号或私聊 QQ 号")
                result = messages(args, path, key, cache)
        print(json.dumps(result, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as error:  # pragma: no cover - surfaced to the app
        fail(f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
