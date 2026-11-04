# 微信数据库密钥读取验证（Windows）

先在电脑版微信登录本人账号。此脚本负责密钥提取和本机数据库校验；CHAOS 的微信自动同步使用验证后的密钥读取已绑定会话的文字消息。

双击项目根目录或发布包中的 `setup-wechat.cmd`，脚本会尝试定位数据目录；未找到时可手动输入。多个账号目录时会提示选择。初始化成功后，密钥会使用当前 Windows 用户的数据保护功能保存到本机 CHAOS 配置目录。也可指定目录和账号：

```powershell
.\setup-wechat.cmd -DataDir "D:\xwechat_files" -Account "wxid_账号目录名"
```

已有的 `wechat-key.py` 仍可独立用于只验证、不保存：

```powershell
python -X utf8 scripts/wechat-key.py --data-dir "D:\xwechat_files"
```

`--data-dir` 可指向 `xwechat_files`、一个账号目录或其 `db_storage`。有多个账号时，使用 `--account` 指定账号文件夹名。脚本只读扫描运行中的 `Weixin.exe`，用联系人库和 `message_*.db` 的首页校验每个候选密钥；默认不保存，也不显示密钥。若当前微信版本不兼容，会失败并报告已验证的数据库数量。

需要供 CHAOS 自动同步使用时，追加 `--save`。结果使用 Windows 当前用户的数据保护功能加密，保存在 `%APPDATA%\CHAOS\wechat-keys.bin`；可用 `CHAOS_CONFIG_DIR` 指定其他本机配置目录。请勿把该文件放入 Markdown 工作目录或提交到 Git。该脚本不读取聊天正文，不修改微信数据文件，也不注入微信进程。
