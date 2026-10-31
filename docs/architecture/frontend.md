# 前端结构

`App.tsx` 管理连接、共享快照、顶部导航、编辑窗口和右键入口。`pages/` 组织页面及其导航状态，功能控件放在 `features/`；通用交互放在 `components/`。控件不反向依赖页面，跨控件的编辑类型放在 `types/editor.ts`。

```text
apps/web/src/
  App.tsx
  pages/             Workspace、Today、Knowledge、Review
  features/
    workspace/       业务导航、业务线、节点、条目、拖动、详情及 Notes
    today/           当天安排、节点预览、联络与已记录侧栏、录入区
    actual/          实际表单、候选选择、已选内容、关联状态、记录列表
    capture/         快速新增和消息解析
    review/          汇总数据、周图表、实际记录、复盘、只读时间线
    settings/        工作目录、主题、备份
    sync/            不改变主页面布局的附加消息与设置弹窗
  components/        通用表单、重要性、SlidingTabs
  types/             编辑入口类型
  styles/base.css    主题和全局基础样式
  styles.css         功能样式的统一导入入口
```

工作空间页面负责筛选、项目分组与保存编排，`BusinessLineTrack` 组织一条业务线，`MilestonePoint` 组织节点，`TodoRows` 展示条目。分组筛选放在纯函数 `workspaceGroups.ts`，由工作空间和知识页复用；拖动状态集中在 `useWorkspaceDrag`。

今日页面组合 `TodaySidebar`、`TodayAgenda` 和 `TodayCapture`。侧栏组合联络清单与 `ActualRecordList`，录入区通过通用 `SlidingTabs` 切换实际录入和快速新增。两个面板保持挂载以保留草稿，非活动面板使用 `inert`；键盘切换、动画和焦点行为由同一控件维护。

`ActualRecordForm` 管理时间、正文、保存与错误；`useActualAssociations` 管理关联、完成选择和批注草稿。`ActualAssociationPicker` 组合“待添加”和“已添加”，添加与移除不写文件。已选节点和条目都可选择“本次完成”；节点有下属条目时显示影响数量，子条目随节点勾选。保存统一经过 `api.ts`，由本地服务一次发布实际记录、完成事实与 Notes，失败时保留表单。取消或清空不发布草稿；新增 TODO／IDEA 和节点统一由“待办 / 节点”页签负责。

回顾页面组织图表、每日实际记录及只读时间线；汇总计算放在 `reviewData.ts`。FullCalendar 仅在时间线需要时延迟加载，已移除交互插件。完整记录的修改通过共享实际表单完成，不在时间线上增加第二套编辑操作。

各功能目录维护自己的 CSS，`styles.css` 只保留有序导入，通用控件样式随控件放置。领域规则仍由 `packages/domain` 提供，文件读写与跨文件一致性仍由本地服务负责；前端控件不直接操作 Markdown。

QQ／微信设置从既有设置进入附加弹窗，专用样式限定在同步控件内，消息组件按需加载。原有四页布局、录入和编辑窗沿用 main 方案。业务接口与扩展方法见[标准业务 API](business-api.md)。
