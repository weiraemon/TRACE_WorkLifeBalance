# R0 复用评估

核实时间：2026-10-23。数据由 `node scripts/research.mjs` 从官方 GitHub API 取得，原始响应摘要见 [reuse-sources.json](reuse-sources.json)。Star 是核实时点数据，最近 push 不是质量保证；许可证以实际使用版本的包内 LICENSE 为准。以下项目均未归档。

| 官方项目                                                                 |   Star | 最近 push（UTC 日期） | 仓库许可证              | R0 决策与理由                                                                                                                           |
| ------------------------------------------------------------------------ | -----: | --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [shadcn/ui](https://github.com/shadcn-ui/ui)                             | 126317 | 2026-10-23            | MIT                     | 评估组件组合方式；直接复用其底层 Radix，不同时维护第二套生成组件与构建配置                                                              |
| [Radix Primitives](https://github.com/radix-ui/primitives)               |  19418 | 2026-10-14            | MIT                     | **采用** Dialog 的焦点管理、Escape 和模态可访问性，以及统一图标                                                                         |
| [Tailwind](https://github.com/tailwindlabs/tailwindcss)                  |  98031 | 2026-10-19            | MIT                     | 暂不安装；当前原生 CSS Tokens 已覆盖一个主题，不加工具链即可维护                                                                        |
| [dnd-kit](https://github.com/clauderic/dnd-kit)                          |  17746 | 2026-10-22            | MIT                     | 暂不安装；空间实体通过直接上级选择移动，节点按日期自动排序，键盘可操作。日历拖拽由 FullCalendar 提供                                    |
| [TanStack Table](https://github.com/TanStack/table)                      |  28513 | 2026-10-21            | MIT                     | 暂不安装；目前是横向空间与简单分组汇总，不需要表格引擎                                                                                  |
| [TanStack Virtual](https://github.com/TanStack/virtual)                  |   7157 | 2026-10-22            | MIT                     | 暂不安装；先在真实单用户 Vault 测量性能，避免提前引入虚拟滚动复杂度                                                                     |
| [React Hook Form](https://github.com/react-hook-form/react-hook-form)    |  44878 | 2026-10-23            | MIT                     | 暂不安装；统一小表单、浏览器控件与共享 Zod 校验足够；复杂联动增多时再评估                                                               |
| [Zod](https://github.com/colinhacks/zod)                                 |  44181 | 2026-10-19            | MIT                     | **采用**；所有记录、API 与 UI 创建共用版本化契约及 TS 类型                                                                              |
| [Zustand](https://github.com/pmndrs/zustand)                             |  58864 | 2026-10-22            | MIT                     | 暂不安装；一个工作台状态根，无跨页面独立数据库或状态副本                                                                                |
| [FullCalendar](https://github.com/fullcalendar/fullcalendar)             |  20712 | 2026-10-16            | MIT（标准版）           | **采用**标准 timeGrid + interaction；现成选择、拖动、拉伸与重叠展示。单个实际 day grid 与独立刻度共用滚动容器，不使用 Premium Scheduler |
| [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) |   4067 | 2026-10-22            | MIT                     | 研究兼容性，R0 不解析或修改其任务语法，不制造状态同步冲突                                                                               |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview)            |   9408 | 2025-11-17            | MIT                     | Frontmatter 可供查询；截至核实最近 push 较旧，不依赖其内部 API                                                                          |
| [官方插件示例](https://github.com/obsidianmd/obsidian-sample-plugin)     |   4582 | 2026-08-02            | 0BSD                    | 参考 Vault 文件与插件边界；R0 不安装 Obsidian 插件即可运行                                                                              |
| [AFFiNE](https://github.com/toeverything/AFFiNE)                         |  73774 | 2026-10-23            | GitHub 标为 NOASSERTION | 仅作为空间布局的产品参考，不复制代码、Fork 或引入其持久化；需逐目录核实许可证才可能复用代码                                             |

另外采用 React / React DOM（MIT）、YAML（ISC）、Vite / Vitest / tsx / Playwright（各包 LICENSE 见 node_modules 与 lockfile）。TS 类型与原生浏览器输入控件具备成熟生态，无需自建日期选择器或状态框架。

2026-10-24 新增 react-markdown 10.1.0（MIT），用于节点详情的正文阅读，按需加载；使用其默认安全 URL 处理，禁用原始 HTML。编辑只使用 textarea，不引入第二套文档存储或富文本编辑器。本地附件、Obsidian 嵌入与专有 Markdown 扩展暂不预览。

## 维护与性能取舍

- 日历单独懒加载；数据不复制到 localStorage、IndexedDB 或数据库。
- 一个 npm 项目，无 workspace 发布包、依赖注入框架、服务编排或云账号。
- Vault 每 5 秒在可见页面重新扫描；先换取简单可靠的移动发现与外部修改检测。超大 Vault 的增量索引留待真实测量。
- 固定四层计划实体，会议 / 讨论 / 修改 / 审阅共用节点，不再另外建立会议、反馈、承诺或验收对象。
- 开源分发保留包许可证，锁定 `package-lock.json`。初次安装发现 Vitest 3 的安全公告，升级至 5.0.5；复核审计为 0 漏洞。审计结果有时间性，后续发布需重跑。

## 每模块的简化审阅

| 模块       | 复用 / 最小方案                              | 对用户记录成本与事实来源的影响                 |
| ---------- | -------------------------------------------- | ---------------------------------------------- |
| 工作空间   | 四个固定实体、同一个计划表单、组合原生 CSS   | 归属自动带入，只保存直接父级；节点统一维护日期 |
| 节点与待办 | 五档重要性色、自己 / To / From、待办圆圈完成 | 交接直接从待办推导，避免额外承诺对象           |
| 今日实际   | 独立 actual 契约、简单表单、FullCalendar     | 三个必填项；只在今日录入，不创建重复入口       |
| 资源       | 独立 UUID、原生编辑器                        | 同一资源供多个实体引用，不复制资料             |
| 文件服务   | Node fs、YAML AST、内容哈希                  | 正文与其他字段原样保留，Markdown 为权威数据    |
| 回顾       | 从实际记录与完成关联即时计算                 | 不重复录入耗时，跨项目不猜测分摊               |
| 备份       | 本地 JSON 快照与修改前备份                   | 仅用于恢复，不是在线编辑的第二数据源           |

没有引入自建按钮框架、通用工作流 DSL、Agent 编排、微服务、事件总线、插件加载器或第二知识库。
