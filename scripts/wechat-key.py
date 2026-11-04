"""Read-only Windows WeChat 4.x key probe for the signed-in user's local databases.

Key scanning/validation logic adapted from fanyuantaier/wechatauto-replica,
Apache-2.0: https://github.com/fanyuantaier/wechatauto-replica
No process injection, message query, or plaintext key output.
"""
import argparse
import ctypes
import hashlib
import hmac as hmac_mod
import json
import os
import re
import struct
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path
from typing import Dict, List, Optional, Tuple

PAGE_SZ = 4096

RESERVE_SZ = 80

CONFIG_CIPHER_NAME = b'com.Tencent.WCDB.Config.Cipher'

CONFIG_XOR_MASK = bytes.fromhex('d2c7442458020000004889442450488b450048844c2448488944254048584c24')

HEX_LITERAL_RE = re.compile(b"[xX]'([0-9a-fA-F]{64,192})'")

class _MBI(ctypes.Structure):
    _fields_ = [('BaseAddress', ctypes.c_void_p), ('AllocationBase', ctypes.c_void_p), ('AllocationProtect', wintypes.DWORD), ('__alignment1', wintypes.DWORD), ('RegionSize', ctypes.c_size_t), ('State', wintypes.DWORD), ('Protect', wintypes.DWORD), ('Type', wintypes.DWORD), ('__alignment2', wintypes.DWORD)]

def _pbkdf2(passwd: bytes, salt: bytes, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac('sha512', passwd, salt, iters, dklen=32)

def _verify_enc_key(enc_key: bytes, page1: bytes, salt: Optional[bytes]=None) -> bool:
    """验证 enc_key 是否为 page1 的 SQLCipher 4 密钥。

    - enc_key 为 32 字节裸 key：默认用文件头前 16 字节作 salt（标准形式）；
    - enc_key 为 48 字节 key+salt：显式 salt 优先于文件头（明文头模式）；
    - 也允许单独传 salt 参数覆盖（供提取逻辑按 96hex 拆分尝试）。
    """
    if len(page1) < PAGE_SZ:
        return False
    if len(enc_key) == 48 and salt is None:
        (enc_key, salt) = (enc_key[:32], enc_key[32:])
    if salt is None:
        salt = page1[:16]
    elif len(salt) != 16:
        return False
    mac_salt = bytes((b ^ 58 for b in salt))
    mac_key = _pbkdf2(enc_key, mac_salt, 2)
    hmac_data = page1[16:PAGE_SZ - RESERVE_SZ + 16]
    stored_hmac = page1[PAGE_SZ - 64:PAGE_SZ]
    hm = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hm.update(struct.pack('<I', 1))
    return hm.digest() == stored_hmac

class WeChatDB:

    def _extract_keys_pid(self, pid: int, tested: set) -> Dict[str, bytes]:
        h = _k32.OpenProcess(16 | 1024, False, pid)
        if not h:
            return {}
        try:

            def read(addr: int, n: int):
                buf = ctypes.create_string_buffer(n)
                br = ctypes.c_size_t(0)
                if _k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(br)) and br.value:
                    return buf.raw[:br.value]
                return None
            needles = self._find_bytes(h, read, CONFIG_CIPHER_NAME)
            pairs = [struct.pack('<Q', addr) + struct.pack('<Q', len(CONFIG_CIPHER_NAME)) for addr in needles]
            keys: Dict[str, bytes] = {}
            for pair in pairs:
                for qaddr in self._find_bytes(h, read, pair):
                    node = read(qaddr - 16, 80)
                    if not node or len(node) < 64:
                        continue
                    if struct.unpack_from('<Q', node, 16)[0] not in needles:
                        continue
                    if struct.unpack_from('<Q', node, 24)[0] != len(CONFIG_CIPHER_NAME):
                        continue
                    config_ptr = struct.unpack_from('<Q', node, 40)[0]
                    if not 65536 <= config_ptr < 140737488355328:
                        continue
                    obj = read(config_ptr + 136, 40)
                    if not obj or len(obj) < 24:
                        continue
                    data_ptr = struct.unpack_from('<Q', obj, 8)[0]
                    data_len = struct.unpack_from('<Q', obj, 16)[0]
                    if not (0 < data_len <= 1024 and 65536 <= data_ptr < 140737488355328):
                        continue
                    blob = read(data_ptr, int(data_len))
                    if not blob or len(blob) != data_len:
                        continue
                    decoded = bytes((v ^ CONFIG_XOR_MASK[i % len(CONFIG_XOR_MASK)] for (i, v) in enumerate(blob)))
                    for m in HEX_LITERAL_RE.finditer(decoded):
                        run = m.group(1).decode().lower()
                        starts = [0]
                        if len(run) > 96:
                            starts += list(range(0, len(run) - 63, 32))
                            starts.append(len(run) - 64)
                        for s in dict.fromkeys(starts):
                            if s + 64 > len(run):
                                continue
                            cand = bytes.fromhex(run[s:s + 64])
                            if cand in tested or not self._probable_key(cand):
                                continue
                            tested.add(cand)
                            explicit = None
                            if s + 96 <= len(run):
                                explicit = bytes.fromhex(run[s + 64:s + 96])
                            salt_choices = [None]
                            if explicit:
                                salt_choices.append(explicit)
                            for salt_opt in salt_choices:
                                for (rel, path, _) in self._db_files:
                                    if rel in keys:
                                        continue
                                    try:
                                        with open(path, 'rb') as f:
                                            page1 = f.read(PAGE_SZ)
                                    except OSError:
                                        continue
                                    if _verify_enc_key(cand, page1, salt=salt_opt):
                                        keys[rel] = cand + (salt_opt or b'')
                                        break
        finally:
            _k32.CloseHandle(h)
        return keys

    @staticmethod
    def _probable_key(b: bytes) -> bool:
        return len(b) == 32 and len(set(b)) >= 15 and (b not in {b'\x00' * 32, b'\xff' * 32})

    @staticmethod
    def _find_bytes(h, read, needle: bytes) -> List[int]:
        hits = []
        addr = 0
        while True:
            mbi = _MBI()
            r = _k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
            if r == 0:
                break
            if mbi.State == 4096 and mbi.Protect & 255 & 230 and (not mbi.Protect & 256) and (0 < mbi.RegionSize < 268435456):
                buf = read(mbi.BaseAddress or 0, mbi.RegionSize)
                if buf:
                    base = mbi.BaseAddress or 0
                    pos = 0
                    while True:
                        pos = buf.find(needle, pos)
                        if pos < 0:
                            break
                        hits.append(base + pos)
                        pos += 1
            addr = (mbi.BaseAddress or 0) + mbi.RegionSize
        return hits


_k32 = ctypes.WinDLL('kernel32', use_last_error=True) if sys.platform == 'win32' else None
if _k32:
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(_MBI), ctypes.c_size_t]
    _k32.VirtualQueryEx.restype = ctypes.c_size_t
    _k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]


def weixin_pids():
    result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'],
                            capture_output=True, text=True, encoding='gbk', errors='replace',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    pids = []
    for line in result.stdout.splitlines():
        fields = line.strip('"').split('","')
        if len(fields) > 1 and fields[1].isdigit():
            pids.append(int(fields[1]))
    return pids


def account_storage(data_dir: Path, account: str | None):
    if data_dir.name == 'db_storage':
        candidates = [data_dir]
    elif (data_dir / 'db_storage').is_dir():
        candidates = [data_dir / 'db_storage']
    else:
        candidates = [p / 'db_storage' for p in data_dir.iterdir()
                      if p.is_dir() and p.name.startswith('wxid_') and (p / 'db_storage').is_dir()]
    if account:
        candidates = [p for p in candidates if p.parent.name == account]
    if len(candidates) != 1:
        raise ValueError('请指定唯一账号目录；当前匹配到 %d 个账号' % len(candidates))
    return candidates[0]


def protected_blob(data: bytes):
    class Blob(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_byte))]
    source = ctypes.create_string_buffer(data)
    source_blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    target_blob = Blob()
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    crypt32.CryptProtectData.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    if not crypt32.CryptProtectData(ctypes.byref(source_blob), 'CHAOS WeChat keys', None, None, None, 0, ctypes.byref(target_blob)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(target_blob.pbData, target_blob.cbData)
    finally:
        kernel32 = ctypes.WinDLL('kernel32')
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(ctypes.cast(target_blob.pbData, ctypes.c_void_p))


def main():
    parser = argparse.ArgumentParser(description='验证本人微信数据库密钥，不打印密钥')
    parser.add_argument('--data-dir', required=True, type=Path, help='xwechat_files、账号目录或 db_storage')
    parser.add_argument('--account', help='多账号时指定账号文件夹名')
    parser.add_argument('--save', action='store_true', help='使用 Windows 当前用户保护密钥并保存到本机 CHAOS 配置目录')
    args = parser.parse_args()
    if sys.platform != 'win32': parser.error('仅支持 Windows')
    storage = account_storage(args.data_dir.resolve(), args.account)
    files = [storage / 'contact' / 'contact.db', *sorted((storage / 'message').glob('message_[0-9]*.db'))]
    files = [p for p in files if p.is_file()]
    if len(files) < 2: parser.error('未找到联系人库和消息库')
    reader = WeChatDB()
    reader._db_files = [(str(p.relative_to(storage)), str(p), p.stat().st_size) for p in files]
    keys = {}; tested = set()
    pids = weixin_pids()
    if not pids: parser.error('请先登录电脑版微信')
    for pid in pids:
        keys.update(reader._extract_keys_pid(pid, tested))
        if len(keys) == len(files): break
    if len(keys) != len(files):
        parser.error('仅验证通过 %d/%d 个数据库，请确认账号已登录且微信版本兼容' % (len(keys), len(files)))
    print('已验证 %d 个数据库密钥（联系人库和消息库），未输出密钥。' % len(keys))
    if args.save:
        config = Path(os.environ.get('CHAOS_CONFIG_DIR') or Path(os.environ['APPDATA']) / 'CHAOS')
        config.mkdir(parents=True, exist_ok=True)
        destination = config / 'wechat-keys.bin'
        payload = json.dumps({'version': 1, 'account': storage.parent.name,
                              'dataDir': str(storage), 'keys': {rel: key.hex() for rel, key in keys.items()}}).encode()
        temp = destination.with_suffix('.bin.tmp')
        try:
            temp.write_bytes(protected_blob(payload))
            temp.replace(destination)
        finally:
            temp.unlink(missing_ok=True)
        print('已将密钥加密保存到当前 Windows 用户的 CHAOS 本机配置目录。')

if __name__ == '__main__':
    main()
