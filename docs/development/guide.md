# 开发与故障处理

## 代码位置

| 职责                                   | 位置                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| 新契约、日期、关联校验、计时去重       | packages/domain/index.ts                                             |
| 层级、排序、当天清单、完成推导         | packages/domain/workspace.ts                                         |
| 文件安全、跨文件发布与恢复、升线、删除 | apps/local-service/src/native/vault.ts                               |
| Notes 分层与受管段落                   | apps/local-service/src/native/line-notes.ts                          |
| HTTP 会话与本地打开                    | apps/local-service/src/server.ts                                     |
| 本机工作目录配置                       | apps/local-service/src/local-config.ts、项目根目录 .chaos.local.json |
| 页面组织与导航状态                     | apps/web/src/pages                                                   |
| 实际录入、关联选择、已记录列表         | apps/web/src/features/actual                                         |
| 今日安排、联络侧栏、录入切换           | apps/web/src/features/today                                          |
| 消息识别与快速新增                     | apps/web/src/features/capture                                        |
| 业务线、节点、条目、拖动、右键和 Notes | apps/web/src/features/workspace                                      |
| 回顾图表与只读时间线                   | apps/web/src/features/review                                         |
| 通用控件与基础样式                     | apps/web/src/components、apps/web/src/styles                         |
| 消息同步与模型配置                     | apps/local-service/src/sync、apps/web/src/features/sync              |
| 固化的产品边界                         | AGENTS.md                                                            |

开发模式为同一个本地服务挂载 Vite。默认端口 4317；E2E 用独立端口 4318。构建后运行生产服务，源码变更不会自动重启已有生产服务。

Windows x64 桌面发布使用 `npm run package:desktop`：前端与统一服务由 esbuild/Vite 构建到 `.desktop/`，Electron Packager 生成 `CHAOS.exe` 并压缩到 `releases/`。`apps/desktop` 只负责窗口、目录选择、QQ 初始化工具、单实例与子进程生命周期，不实现业务写入。每次新建发布目录，不复制本机配置或用户数据。`project-root.ts` 统一定位静态资源和 QQ 脚本，服务包保留 `apps/local-service/src/` 层级。

`npm run desktop` 构建后启动开发用桌面窗口；`npm run test:desktop` 检查已构建的 `.desktop/`。内置 Python 3.12.10 与 SQLCipher 0.6.4，下载地址及 SHA-256 锁定在 `scripts/desktop-runtimes.json`，构建时实测原生数据库能力。桌面服务优先使用 `CHAOS_BUNDLED_PYTHON`，网页版继续尊重原 Python 配置。QQ 初始化工具复用原脚本并自动识别内置环境，不再安装 Node/Python。

渲染器启用 sandbox、contextIsolation，关闭 Node 集成；preload 仅暴露目录选择和固定 QQ 初始化入口，并校验调用来自主窗口同源页面。外部 HTTP/HTTPS 链接交给默认浏览器。配置保存在 `%APPDATA%\CHAOS\workspace.json`，浏览器外观缓存位于其 `desktop/` 子目录。关闭窗口先通过进程 IPC 让统一服务退出，服务收到父进程断开也会关闭，释放工作目录锁。桌面默认仍使用 4317 端口，启动前需退出源码服务。

前端沿用 5 秒重读，窗口激活和恢复可见时立即同步，并校准“今日”的日期。自动跨天不重挂录入表单；空白实际表单更新时间，已填写的草稿保持日期时间并提供历史日期提示及更正入口。

[前端架构](../architecture/frontend.md)说明页面、控件、状态与样式的边界。实际录入现在支持在同一次保存中完成关联节点，前后端契约为 `atlas-lines-25`；存储结构不变。升级后需重启本地服务并刷新页面，已有记录无需迁移。

## 验证

运行 `npm run check` 检查领域／集成、前端构建与网页 E2E；桌面改动另运行 `npm run build:desktop`、`npm run test:desktop`。设置 `CHAOS_DESKTOP_EXECUTABLE` 可对打包后的绝对 exe 路径执行同一组桌面测试。测试目录为系统随机临时目录或项目 .test-vault，不自行搜索用户目录。文件测试依赖 NTFS 硬链接与 Junction 权限，不通过跳过断言获取通过结果。

成功连接的工作目录保存为项目根目录 `.chaos.local.json` 中的 `vaultPath`（绝对路径），启动时自动连接。文件及写入临时文件均被 Git 忽略，不随仓库分发；工作内容仍以 Markdown 目录为准。目录不存在或被其他服务占用时，服务继续启动，界面保留地址并提示原因。配置 JSON 损坏时保留原文，修正配置后重新启动。

测试或独立演示服务可通过 `ATLAS_CONFIG_PATH` 指向另一份配置，避免改变日常使用的默认目录；E2E 固定使用 `.test-vault/e2e-local.json`。

## 故障处理

- 前后端契约不符：保留输入，在原终端 Ctrl+C，重新构建、启动、刷新。
- 保存冲突：保留草稿，核对外部 Markdown 后重新加载合并，不强制覆盖。
- 跨文件操作中断：重新连接同一目录，系统按短期发布日志继续；遇到外部内容冲突会停止。不要删除 pending.json 来假装已完成。
- 文件锁残留：连接目录时检查进程是否存在及启动标识，确认进程退出或 PID 已被复用后自动回收；随后继续现有的中断恢复。活跃锁、无法确认的进程、外机锁或损坏锁均不自动移除。若仍提示占用，先关闭原服务；损坏锁须核实后手动处理，不结束未知进程。
- 重复 ID、非法 UTF-8 / Frontmatter：在编辑器核对原文件，应用不猜测修复。
- 普通临时文件残留：核对原文件与发布日志，不批量自动替换。
- 手动恢复中断：核对已恢复文件，重新选择快照并提供当前版本；恢复不生成自动备份。
- 目录切换：旧窗口停止写入，保留输入后重新连接需要的目录。
- 端口占用：检查已有服务或设置 ATLAS_PORT，不直接结束未知占用者。
- 硬链接、原子替换失败：检查本地 NTFS 与权限，不退化为直接覆盖写入。
- 无旧数据目录：仅使用新结构，仓库不保留迁移工具或旧契约分支。

## QQ 接入与主线合并

现有页面、记录录入、完成推导和日期规则沿用主线实现。QQ／微信入口放在齿轮“备份”的“外部消息接入”内，消息组件按需加载，专用弹窗样式限定在同步界面；现有编辑窗口继续使用原有控件与样式。工作目录仍由 `.chaos.local.json` 恢复，QQ／AI 配置独立存储。

标准业务 API 与接入边界见[业务接口与扩展约定](../architecture/business-api.md)。网页与 QQ／AI 共用标准业务服务，依赖检查已纳入 npm run check。验证使用临时工作目录和本地模拟模型接口，不连接真实 QQ 账号或发送真实消息。
