# 开发与故障处理

## 代码位置

| 职责                                   | 位置                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- |
| 新契约、日期、关联校验、计时去重       | packages/domain/index.ts                                             |
| 层级、排序、当天清单、完成推导         | packages/domain/workspace.ts                                         |
| 文件安全、跨文件发布与恢复、升线、删除 | apps/local-service/src/vault.ts                                      |
| Notes 分层与受管段落                   | apps/local-service/src/line-notes.ts                                 |
| HTTP 会话与本地打开                    | apps/local-service/src/server.ts                                     |
| 本机工作目录配置                       | apps/local-service/src/local-config.ts、项目根目录 .chaos.local.json |
| 页面组织与导航状态                     | apps/web/src/pages                                                   |
| 实际录入、关联选择、已记录列表         | apps/web/src/features/actual                                         |
| 今日安排、联络侧栏、录入切换           | apps/web/src/features/today                                          |
| 消息识别与快速新增                     | apps/web/src/features/capture                                        |
| 业务线、节点、条目、拖动、右键和 Notes | apps/web/src/features/workspace                                      |
| 回顾图表与只读时间线                   | apps/web/src/features/review                                         |
| 通用控件与基础样式                     | apps/web/src/components、apps/web/src/styles                         |
| 固化的产品边界                         | AGENTS.md                                                            |

开发模式为同一个本地服务挂载 Vite。默认端口 4317；E2E 用独立端口 4318。构建后运行生产服务，源码变更不会自动重启已有生产服务。

[前端架构](../architecture/frontend.md)说明页面、控件、状态与样式的边界。实际录入现在支持在同一次保存中完成关联节点，前后端契约为 `atlas-lines-13`；存储结构不变。升级后需重启本地服务并刷新页面，已有记录无需迁移。

## 验证

运行 `npm test`、`npm run build`、`npm run test:e2e`。测试目录为系统随机临时目录或项目 .test-vault，不自行搜索用户目录。文件测试依赖 NTFS 硬链接与 Junction 权限，不通过跳过断言获取通过结果。

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
