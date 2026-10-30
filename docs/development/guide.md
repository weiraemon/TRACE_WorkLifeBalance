# 开发与故障处理

## 代码位置

| 职责                                   | 位置                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| 新契约、日期、关联校验、计时去重       | packages/domain/index.ts                                                       |
| 层级、排序、当天清单、完成推导         | packages/domain/workspace.ts                                                   |
| 文件安全、跨文件发布与恢复、升线、删除 | apps/local-service/src/native/vault.ts                                         |
| Notes 分层与受管段落                   | apps/local-service/src/native/line-notes.ts                                    |
| 消息同步配置、识别、存储与 QQ 读取     | apps/local-service/src/sync/                                                   |
| HTTP 会话、API 路由与本地打开          | apps/local-service/src/server.ts                                               |
| 消息同步界面                           | apps/web/src/features/sync/                                                    |
| 今日快速收集与实际表单                 | apps/web/src/features/TodayCapture.tsx、QuickCapture.tsx、ActualRecordForm.tsx |
| 原生业务界面（工作空间、知识、回顾等） | apps/web/src/features 根目录                                                   |
| 固化的产品边界                         | AGENTS.md                                                                      |

开发模式为同一个本地服务挂载 Vite。默认端口 4317；E2E 用独立端口 4318。构建后运行生产服务，源码变更不会自动重启已有生产服务。

## 验证

运行 `npm test`、`npm run build`、`npm run test:e2e`。测试目录为系统随机临时目录或项目 .test-vault，不自行搜索用户目录。文件测试依赖 NTFS 硬链接与 Junction 权限，不通过跳过断言获取通过结果。

## 故障处理

- 前后端契约不符：保留输入，在原终端 Ctrl+C，重新构建、启动、刷新。
- 保存冲突：保留草稿，核对外部 Markdown 后重新加载合并，不强制覆盖。
- 跨文件操作中断：重新连接同一目录，系统按短期发布日志继续；遇到外部内容冲突会停止。不要删除 pending.json 来假装已完成。
- 文件锁残留：核实锁中进程确实退出，再移除该锁；不结束未知进程。
- 重复 ID、非法 UTF-8 / Frontmatter：在编辑器核对原文件，应用不猜测修复。
- 普通临时文件残留：核对原文件与发布日志，不批量自动替换。
- 手动恢复中断：核对已恢复文件，重新选择快照并提供当前版本；恢复不生成自动备份。
- 目录切换：旧窗口停止写入，保留输入后重新连接需要的目录。
- 端口占用：检查已有服务或设置 ATLAS_PORT，不直接结束未知占用者。
- 硬链接、原子替换失败：检查本地 NTFS 与权限，不退化为直接覆盖写入。
- 无旧数据目录：仅使用新结构，仓库不保留迁移工具或旧契约分支。
