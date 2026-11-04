"""Read-only WeChat 4.x database adapter for CHAOS.

The DPAPI-protected key file is read only in this process. No key, raw database
page, or unselected chat message is written to disk or printed.
"""
import argparse
import ctypes
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path

import sqlcipher3
import zstandard


def load_keys():
    location = Path(os.environ.get('CHAOS_CONFIG_DIR') or Path(os.environ['APPDATA']) / 'CHAOS') / 'wechat-keys.bin'
    if not location.is_file():
        raise ValueError('请先运行 setup-wechat.cmd 初始化微信数据库密钥')

    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_byte))]

    encrypted = location.read_bytes()
    buffer = ctypes.create_string_buffer(encrypted)
    source = Blob(len(encrypted), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    plain = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p,
                                         ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0,
                                    ctypes.byref(plain)):
        raise ValueError('微信密钥无法由当前 Windows 用户解开，请重新初始化')
    try:
        payload = ctypes.string_at(plain.data, plain.size)
    finally:
        kernel = ctypes.WinDLL('kernel32')
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(ctypes.cast(plain.data, ctypes.c_void_p))
    data = json.loads(payload)
    if data.get('version') != 1 or not isinstance(data.get('keys'), dict):
        raise ValueError('微信密钥文件格式不受支持，请重新初始化')
    root = Path(data['dataDir']).resolve()
    account = data['account']
    if not root.is_dir() or root.parent.name != account or root.name != 'db_storage':
        raise ValueError('微信账号数据目录已变化，请重新初始化')
    keys = {name.replace('\\', '/'): value for name, value in data['keys'].items()}
    self_id = re.sub(r'_\w{4}$', '', account)
    return root, keys, self_id


def snapshot(source, destination):
    wal_source = Path(str(source) + '-wal')
    wal_destination = Path(str(destination) + '-wal')
    for _ in range(3):
        paths = (source, wal_source)
        before = [(item.stat().st_size, item.stat().st_mtime_ns) if item.exists() else None
                  for item in paths]
        shutil.copyfile(source, destination)
        if wal_source.exists():
            shutil.copyfile(wal_source, wal_destination)
        else:
            wal_destination.unlink(missing_ok=True)
        after = [(item.stat().st_size, item.stat().st_mtime_ns) if item.exists() else None
                 for item in paths]
        if before == after:
            return
    raise ValueError('微信数据库正在写入，请稍后重试')


@contextmanager
def connect(root, keys, relative):
    key = keys.get(relative)
    path = root / relative
    if not key or not path.is_file() or not re.fullmatch(r'[0-9a-fA-F]{64}(?:[0-9a-fA-F]{32})?', key):
        raise ValueError('微信数据库或密钥已变化，请重新运行 setup-wechat.cmd')
    with tempfile.TemporaryDirectory(prefix='chaos-wechat-read-',
                                     dir=os.environ.get('CHAOS_WECHAT_TEMP_DIR')) as temporary:
        copy = Path(temporary) / path.name
        snapshot(path, copy)
        connection = sqlcipher3.connect(str(copy))
        try:
            connection.execute('PRAGMA key = "x\'' + key + '\'"')
            connection.execute('PRAGMA query_only = ON')
            try:
                connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
            except Exception:
                raise ValueError('微信数据库无法解密，请重新初始化密钥') from None
            yield connection
        finally:
            connection.close()


def decode(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, bytes):
        return ''
    if value.startswith(b'\x28\xb5\x2f\xfd'):
        value = zstandard.ZstdDecompressor().decompress(value, max_output_size=1 << 20)
    return value.decode('utf-8', errors='replace')


def mentions(source, self_id):
    match = re.search(r'<atuserlist>(.*?)</atuserlist>', source, re.I | re.S)
    if not match:
        return False, False
    members = [html.unescape(part.strip().removeprefix('<![CDATA[').removesuffix(']]>'))
               for part in match.group(1).split(',')]
    return any(member.lower() in ('notify@all', '@all') for member in members), self_id in members


def contacts(root, keys):
    with connect(root, keys, 'contact/contact.db') as connection:
        rows = connection.execute(
            'SELECT username,nick_name,remark,alias,local_type,is_in_chat_room '
            'FROM contact WHERE username IS NOT NULL'
        ).fetchall()
    return rows


def unnamed_group_members(root, keys, group_ids, self_id):
    if not group_ids:
        return {}
    placeholders = ','.join('?' for _ in group_ids)
    with connect(root, keys, 'contact/contact.db') as connection:
        rows = connection.execute(
            'SELECT room.username, member.username, member.nick_name, member.remark, member.alias '
            'FROM chat_room AS room '
            'JOIN chatroom_member AS membership ON membership.room_id = room.id '
            'JOIN contact AS member ON member.id = membership.member_id '
            f'WHERE room.username IN ({placeholders}) ORDER BY room.username, membership.member_id',
            tuple(group_ids),
        ).fetchall()
    groups = {group_id: {'members': [], 'memberCount': 0} for group_id in group_ids}
    for group_id, member_id, nickname, remark, alias in rows:
        group = groups[group_id]
        group['memberCount'] += 1
        if member_id != self_id and len(group['members']) < 8:
            group['members'].append((remark or nickname or alias or member_id)[:100])
    return groups


def message_shards(root, keys):
    on_disk = {f'message/{item.name}' for item in (root / 'message').glob('message_[0-9]*.db')}
    if on_disk - keys.keys():
        raise ValueError('微信新增了消息分库，请重新运行 setup-wechat.cmd 验证密钥')
    return sorted(name for name in keys if re.fullmatch(r'message/message_\d+\.db', name)
                  and (root / name).is_file())


def read_messages(root, keys, self_id, chat_id, after, since, limit):
    table = 'Msg_' + hashlib.md5(chat_id.encode('utf-8')).hexdigest()
    rows = contacts(root, keys)
    if chat_id.endswith('@chatroom') and not any(
            username == chat_id and in_room == 1 for username, _, _, _, _, in_room in rows):
        return {'messages': [], 'next': after, 'hasMore': False, 'inactive': True}
    names = {username: remark or nickname or username
             for username, nickname, remark, _, _, _ in rows}
    found = []
    for relative in message_shards(root, keys):
        with connect(root, keys, relative) as connection:
            if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                continue
            shard = Path(relative).name
            rows = connection.execute(
                f'SELECT local_id,server_id,local_type,real_sender_id,create_time,message_content,source '
                f'FROM "{table}" WHERE local_id>? AND (create_time>=? OR ?>0) ORDER BY local_id LIMIT ?',
                (int(after.get(shard, 0)), since, int(after.get(shard, 0)), limit),
            ).fetchall()
            for local_id, server_id, msg_type, sender_id, sent_at, content, source in rows:
                if msg_type != 1:
                    # Advance past unsupported media without forwarding it to AI.
                    found.append({'shard': shard, 'localId': str(local_id), 'skip': True,
                                  'time': int(sent_at)})
                    continue
                sender_row = connection.execute('SELECT user_name FROM Name2Id WHERE rowid=?', (sender_id,)).fetchone()
                sender_id_value = sender_row[0] if sender_row else ''
                if not sender_id_value:
                    raise ValueError('微信发送人无法解析，已停止推进同步游标')
                body = decode(content).strip()
                prefix = sender_id_value + ':\n'
                if chat_id.endswith('@chatroom') and body.startswith(prefix):
                    body = body[len(prefix):]
                if not body:
                    found.append({'shard': shard, 'localId': str(local_id), 'skip': True,
                                  'time': int(sent_at)})
                    continue
                at_all, at_me = mentions(decode(source), self_id)
                found.append({'shard': shard, 'localId': str(local_id),
                              'id': str(server_id) if server_id else f'{shard}:{local_id}',
                              'time': int(sent_at), 'sender': names.get(sender_id_value, sender_id_value)[:100],
                              'senderId': sender_id_value, 'text': body[:12000],
                              'atAll': at_all, 'atMe': at_me and not at_all,
                              'fromSelf': sender_id_value == self_id})
    found.sort(key=lambda row: (row['time'], row['shard'], int(row['localId'])))
    selected = found[:limit]
    next_cursor = dict(after)
    for row in selected:
        next_cursor[row['shard']] = max(int(next_cursor.get(row['shard'], 0)), int(row['localId']))
    return {'messages': [row for row in selected if not row.get('skip')], 'next': next_cursor,
            'hasMore': len(found) > limit}


def main():
    parser = argparse.ArgumentParser(description='只读读取本人微信消息')
    parser.add_argument('action', choices=('status', 'chats', 'messages'))
    parser.add_argument('--chat-id', default='')
    parser.add_argument('--after-json', default='{}')
    parser.add_argument('--since-time', type=int, default=0)
    parser.add_argument('--limit', type=int, default=20)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('微信本机读取仅支持 Windows')
    try:
        root, keys, self_id = load_keys()
        shards = message_shards(root, keys)
        if not shards:
            raise ValueError('未找到已验证的微信消息数据库，请重新初始化')
        if args.action == 'status':
            rows = contacts(root, keys)
            result = {'ok': True, 'dataDir': str(root), 'account': root.parent.name,
                      'shards': len(shards),
                      'groups': sum(u.endswith('@chatroom') and in_room == 1
                                    for u, _, _, _, _, in_room in rows),
                      'contacts': sum(t == 1 and not u.endswith('@chatroom') and u != self_id
                                      for u, _, _, _, t, _ in rows)}
        elif args.action == 'chats':
            rows = contacts(root, keys)
            unnamed = {u for u, nickname, remark, _, _, in_room in rows
                       if u.endswith('@chatroom') and in_room == 1 and not nickname and not remark}
            members = unnamed_group_members(root, keys, unnamed, self_id)
            result = {'groups': [{
                'id': u,
                'name': nickname or remark or ('未命名群：' + '、'.join(members.get(u, {}).get('members', []))
                                              if members.get(u, {}).get('members') else '未命名群'),
                'members': members.get(u, {}).get('members', []),
                'memberCount': members.get(u, {}).get('memberCount', 0),
            } for u, nickname, remark, _, _, in_room in rows
              if u.endswith('@chatroom') and in_room == 1],
                      'contacts': [{'id': u, 'name': nickname or u, 'remark': remark or '',
                                    'alias': alias or ''}
                                   for u, nickname, remark, alias, local_type, _ in rows
                                   if local_type == 1 and not u.endswith('@chatroom') and u != self_id]}
        else:
            if not args.chat_id or len(args.chat_id) > 100:
                raise ValueError('请指定微信会话 ID')
            after = json.loads(args.after_json)
            if not isinstance(after, dict) or any(not re.fullmatch(r'message_\d+\.db', key)
                                                   or not isinstance(value, int) or value < 0
                                                   for key, value in after.items()):
                raise ValueError('微信同步游标无效')
            result = read_messages(root, keys, self_id, args.chat_id, after,
                                   max(0, args.since_time), max(1, min(100, args.limit)))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError)
                          else f'微信读取失败：{type(error).__name__}'}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
