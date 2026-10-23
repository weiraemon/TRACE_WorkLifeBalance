# 开发与故障处理

## 代码位置

| 责任                                                                        | 文件                               |
| --------------------------------------------------------------------------- | ---------------------------------- |
| 契约、状态集合、日期、直接父级与完成关联校验与时间去重                      | `packages/domain/index.ts`         |
| 当天待办、推荐、完成状态与联络汇总                                          | `packages/domain/workspace.ts`     |
| HTTP、同源会话、Vault 会话隔离、原生文件打开                                | `apps/local-service/src/server.ts` |
| YAML、索引、安全路径、原子保存、备份恢复与资源解析                          | `apps/local-service/src/vault.ts`  |
| 导航与页面组合                                                              | `apps/web/src/App.tsx`             |
| 通用按钮、Radix Dialog、表单字段、日期控件                                  | `apps/web/src/components`          |
| 四层空间、详情、计划表单、独立实际表单、资源 / 回顾表单、时间线、Vault 设置 | `apps/web/src/features`            |
| 今日、知识与周回顾                                                          | `apps/web/src/pages`               |
| 颜色、文字、间距与响应式规则                                                | `apps/web/src/styles.css`          |

`npm run dev` 由同一个本地服务挂载 Vite；`npm run build` 输出静态文件，`npm start` 读取它们。默认端口 4317，E2E 使用独立端口 4318。`ATLAS_PORT` 可修改端口。开发时 Vite HMR 关闭，改动后刷新页面；无需第二个反向代理或服务。

`npm run format` 格式化源代码、测试和文档，不格式化示例 Vault。依赖统一用 lockfile；新增运行依赖需更新复用评估与 `node scripts/licenses.mjs` 生成的许可证声明。许可证脚本仅在缺失的 `react-remove-scroll-bar` 包文本处读取官方上游许可证，其余读取安装包。

## 故障恢复

- **新建项目提示旧类型列表 / 数据模型不一致**：旧后端仍在内存运行。先复制未保存输入，在原终端按 Ctrl+C，然后在当前项目目录运行 `npm run build`、`npm start`，刷新并重新连接 Vault。更新文件不会自动重启 `npm start` 的进程。前端检查服务的契约响应头，版本不符时明确提示重启；静态资源与 API 禁用缓存。
- **保存冲突**：保留表单文本，取消后重新加载 Vault，核对 Obsidian 中最新内容，再合并保存；不要反复强制覆盖。
- **另一个窗口切换 Vault**：旧窗口的读写会停止。复制未保存输入，重新连接原路径后继续。
- **重复 ID / 非法 Frontmatter / UTF-8 编码异常**：先在 Obsidian 或文本编辑器中核对错误文件；ATLAS 不猜测修复，也不写回损坏的记录。
- **锁文件残留**：读取 `.atlas/service.lock` 的 pid，确认对应 ATLAS 进程已退出，再手工删除这一个锁文件。不要删除仍在运行服务的锁。
- **临时文件残留**：`.atlas-tmp-*` 不自动作为工作数据。先复制保留，核对原 Markdown 与 `.atlas/backups`，选择恢复；不要批量自动替换。
- **恢复中断**：已恢复文件有修改前的撤销备份；刷新后核对哪些记录已经恢复，再处理剩余。新记录不被恢复操作删除。
- **硬链接或原子替换失败**：检查本地 NTFS、目录权限、杀毒 / 编辑器占用；服务返回失败，不改用直接覆盖写入。
- **4317 已使用**：重复启动会显示占用提示并退出，不影响已有服务。如果已有 ATLAS，直接打开 http://127.0.0.1:4317；需要重启时在原终端按 Ctrl+C，再运行 `npm start`。也可在 PowerShell 执行 `$env:ATLAS_PORT='4319'; npm start`，打开 http://127.0.0.1:4319。不要直接结束未知的占用进程。
- **移动项目目录**：先在原终端用 Ctrl+C 停止服务，再从新目录构建和启动；已有进程不会自动跟随目录移动。构建文件缺失时先执行 `npm run build`。
- **浏览器测试启动失败**：确认 Chrome 已安装，或设置 `ATLAS_BROWSER_CHANNEL=msedge`；查看 trace 与浏览器日志。不要通过跳过失败业务获取通过结果。

测试 Vault 位于系统随机临时目录或项目 `.test-vault`；测试进程从不自行寻找用户 Vault。README、数据安全文档和测试报告共同界定 R0 的支持范围。
