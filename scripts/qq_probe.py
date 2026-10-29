"""Probe how a QQ nt_msg.db copy is encrypted.

Tries a small matrix of header sizes and SQLCipher 4 parameters. It never
prints keys; the caller supplies a keys file and gets only the matching index.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

import sqlcipher3

HEADERS = (1024, 0, 512, 2048, 4096)
PROFILES = (
    (4096, 4000, "HMAC_SHA512", "PBKDF2_HMAC_SHA512"),
    (4096, 256000, "HMAC_SHA512", "PBKDF2_HMAC_SHA512"),
    (4096, 64000, "HMAC_SHA512", "PBKDF2_HMAC_SHA512"),
    (4096, 4000, "HMAC_SHA256", "PBKDF2_HMAC_SHA256"),
    (4096, 256000, "HMAC_SHA256", "PBKDF2_HMAC_SHA256"),
    (1024, 4000, "HMAC_SHA512", "PBKDF2_HMAC_SHA512"),
    (8192, 4000, "HMAC_SHA512", "PBKDF2_HMAC_SHA512"),
)


def resolve_db_dir(root: Path) -> Path:
    candidates = (
        root,
        root / "nt_qq",
        root / "nt_db",
        root / "nt_qq" / "nt_db",
    )
    for candidate in candidates:
        if (candidate / "nt_msg.db").is_file():
            return candidate
    raise FileNotFoundError(f"nt_msg.db not found under {root}")


def strip(source: Path, target: Path, header: int) -> None:
    with source.open("rb") as reader:
        reader.seek(header)
        with target.open("wb") as writer:
            shutil.copyfileobj(reader, writer, 64 << 20)


def open_profile(database: Path, key: str, profile: tuple[int, int, str, str]):
    page_size, kdf_iter, hmac, kdf = profile
    connection = sqlcipher3.connect(str(database))
    try:
        cursor = connection.cursor()
        cursor.execute("PRAGMA cipher_log_level = NONE")
        cursor.execute(f"PRAGMA cipher_page_size = {page_size}")
        escaped = key.replace("'", "''")
        cursor.execute("PRAGMA key = '" + escaped + "'")
        cursor.execute(f"PRAGMA kdf_iter = {kdf_iter}")
        cursor.execute(f"PRAGMA cipher_hmac_algorithm = {hmac}")
        cursor.execute(f"PRAGMA cipher_kdf_algorithm = {kdf}")
        cursor.execute("SELECT count(*) FROM sqlite_master").fetchone()
        return connection
    except Exception:
        connection.close()
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-dir", required=True)
    parser.add_argument("--keys-file", required=True)
    parser.add_argument("--profile-out", default="")
    args = parser.parse_args()

    try:
        path = resolve_db_dir(Path(args.db_dir).expanduser()) / "nt_msg.db"
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1

    keys = []
    for line in Path(args.keys_file).read_text("utf-8").splitlines():
        value = line.strip()
        if 8 <= len(value) <= 64 and all(32 <= ord(char) <= 126 for char in value):
            keys.append(value)
    keys = list(dict.fromkeys(keys))
    if not keys:
        print(json.dumps({"ok": False, "error": "no candidate keys"}, ensure_ascii=False))
        return 1

    with tempfile.TemporaryDirectory(prefix="chaos-qq-probe-") as temp:
        temp_path = Path(temp)
        raw = temp_path / "nt_msg.raw"
        shutil.copy2(path, raw)
        for header in HEADERS:
            stripped = temp_path / f"nt_msg.{header}.db"
            strip(raw, stripped, header)
            for key_index, key in enumerate(keys):
                for page_size, kdf_iter, hmac, kdf in PROFILES:
                    try:
                        connection = open_profile(
                            stripped, key, (page_size, kdf_iter, hmac, kdf)
                        )
                    except Exception:
                        continue
                    connection.close()
                    result = {
                        "ok": True,
                        "keyIndex": key_index,
                        "headerSize": header,
                        "pageSize": page_size,
                        "kdfIter": kdf_iter,
                        "hmac": hmac,
                        "kdf": kdf,
                    }
                    if args.profile_out:
                        output = Path(args.profile_out)
                        output.parent.mkdir(parents=True, exist_ok=True)
                        output.write_text(
                            json.dumps(result, ensure_ascii=False, indent=2),
                            "utf-8",
                        )
                    print(json.dumps(result, ensure_ascii=False))
                    return 0
    print(json.dumps({"ok": False, "keys": len(keys)}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
