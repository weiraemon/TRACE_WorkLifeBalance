# Android 本地版：构建、预览与验收

Android 使用 Capacitor 7 承载现有 React 界面。共享 `WorkspaceService`、`Workspace`、领域契约、Markdown 与 Notes 实现直接编译到本机运行时，不启动 Windows 服务，不复制业务规则，不依赖网络。基于 Windows main `261b1ad`（v0.1.6）开发，桌面仍使用原四页布局。

后续 Windows 与 Android 的新增业务继续在同一主干和共享核心实现；本次保留 Windows 界面只约束本次变更，不限制后续两端共同开发。分工与验收约定见[共用底座的开发约定](../architecture/repository.md#后续-windows-与-android-共用底座的开发约定)。

Android 图标和启动画面共用 `app/src/main/res/drawable/chaos_icon.xml` 矢量资源，未使用的模板多尺寸 PNG 与配套资源已删除。测试截图、复制的网页资产、构建目录、工具链和签名凭据继续留在忽略目录；正常源码图片不作全局忽略。

## 已明确的手机界面

用户在 2026-11-03 明确要求 Android 使用独立导航与页面组合。这是对默认“手机仅窄屏重排”的界面范围扩展，Windows 不随之调整。

| 手机入口 | 单一职责                                               | 复用内容                                                                      |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 编辑     | 记录实际，或快速新建待办／想法／节点；一次展示一个表单 | ActualRecordForm、QuickCapture、关联选择与领域校验；完整编辑复用 WorkItemForm |
| 已做     | 查看当天实际投入并修改记录                             | ActualRecordList、ActualRecordForm、timeTotals                                |
| 待做     | 当天安排、逾期处理与待联系对象                         | TodayAgenda、OverdueEvents、OverdueTodos、contactsForDay                      |
| 空间     | 先选择项目与业务线，再查看一条竖向业务线               | workspaceGroups、完成与日期排序查询、现有编辑／删除表单                       |
| 回顾     | 周投入、完成情况、每日计划与实际及已有复盘             | 现有 Review 及按需加载的 FullCalendar                                         |
| 笔记     | 同一套业务线导览，阅读／编辑 Notes，快速追加随手记     | NotesContent、notes.read、notes.save                                          |

项目是中心圆，业务线为周围圆。每组最多四条线，更多业务线继续向下延伸。进入业务线后，日期与标签在轴左，标题与条目在轴右，待办池固定末端。左右滑动切线，同时提供上一条／下一条按钮。正文采用 16px，不用缩小字体压缩信息。更多菜单承接触摸编辑、完成、日期、重要性、移动／排序、批注、升线和删除。

随手记直接追加至所属业务线 Notes，不增加备忘录数据表或正文副本。未保存表单、批注和笔记在离开前确认；冲突保留草稿。项目和业务线删除仍额外确认。现有完整复盘文章展示继续沿用，未增加独立的复盘编辑工作流。

本期不包含 QQ／微信接入、AI 服务、自动同步、二维码交换或后台任务。桌面的这些入口和能力保持现状。

## 文件能力与限制

- 通过系统 `ACTION_OPEN_DOCUMENT_TREE` 选择目录并记住持久授权，不要求全盘权限。
- 首版只接受内部存储的 `com.android.externalstorage.documents` 本地提供方。SD 卡和云盘提供方明确拒绝，不能把 URI 转换成磁盘绝对路径。
- 连接时验证创建、严格读取、fsync、无覆盖重命名及删除能力。文件原文 SHA-256 作为 revision，非法 UTF-8、重复 ID 与外部修改均明确诊断。
- 同一目录使用进程文件锁与设备归属标记。所有文件请求在单线程执行器中串行；快照与共享业务读写还经过 Workspace 串行边界。
- 多文件修改先发布 `.atlas/pending.json`。单文件用 `.atlas/android-swap.json` 描述暂存新文与原文件的可恢复交换。每步校验内容版本；中断后重新连接恢复，发现第三种内容则停止，不覆盖。未完成批次期间拒绝其他写入。
- 日志的 `.preparing` 文件尚未授权业务写入，重连时清理；已发布日志与原文暂存保留到操作完成。这些只用于未完成操作恢复，不是自动备份或操作历史。
- 备份仍由用户手动创建，最多三份；只包含受管 Markdown。恢复按稳定 UUID 定位当前文件并校验预期版本。
- “导出完整目录”通过系统文件选择器写 ZIP，包含普通工作文件和附件，排除运行锁、发布日志、内部配置、`.git`、`.obsidian`、node_modules。导出前必须不存在未完成批次；它不承担增量同步或覆盖导入。
- 资源打开沿用授权边界与文档类型限制。其他设备上的绝对路径不能在 Android 打开；手机也需要安装能打开相应文件的应用。
- 配置只存本机 SharedPreferences；系统自动备份关闭。Capacitor 调用日志关闭，避免将工作正文记录到平台日志。开发 APK 的调试桥仅用于本机验收；正式发布需另行签名。

SAF 没有被当作 NTFS 原子替换。这里验证的是指定本地提供方上的可恢复发布；不能将模拟器测试视为任意厂商设备、任意存储提供方或真实断电的证明。

## 电脑上的快速界面预览

需要直接双击体验时，使用本地 `releases/CHAOS-Android-Preview-0.1.6-Setup.exe`：按当前用户安装，无需管理员权限、Node.js、Android Studio 或模拟器。安装后打开“CHAOS Android 界面预览”，默认 390×844 竖屏窗口，可调整宽度，用鼠标点击、滚动与拖动切线。它运行和 APK 相同的六入口 React 界面，业务仍由同一份 `WorkspaceService` 执行。

预览 EXE 使用 Windows 本地文件适配，**不是 Android 系统模拟器**。首次在 `%APPDATA%/CHAOS-Android-Preview/sample-workspace` 创建合成示例，后续保留测试修改；配置和浏览器数据与 Windows 正式版隔离，每次启动默认回到示例目录。卸载不删除这个目录。安装包和便携预览 EXE 只放本地 `releases/`，不提交，也不创建 GitHub Release。

```powershell
npm run package:android:preview
npm run test:android:preview
```

打包复用现有 Electron 外壳，使用固定 SHA-256 校验的官方 NSIS 3.11 便携编译器生成单个安装 EXE；工具缓存被 Git 忽略，不全局安装依赖。自动验收安装后的真实 EXE、六页切换、完成、Notes／实际保存、隔离配置、重启恢复和卸载保留额外文件。手机软键盘、系统栏、返回键、SAF 权限与 Android 文件安全仍使用 APK／模拟器验证，不能由这个 EXE 证明。

开发时也可以不打包：

```powershell
npm ci
npm run preview:android
```

打开 http://127.0.0.1:4320/?ui=android。预览使用 `.test-vault/android-preview` 合成目录与单独配置，不连接用户的真实目录；Ctrl+C 退出。该入口使用真实共享业务服务，可验证页面交互，但不代替 Android 文件能力测试。

默认 `/` 继续打开 Windows 原界面；`?ui=android` 只选择手机页面组合，不改变后端业务规则。已有 React 表单、控件和查询直接复用，不通过工具自动生成另一套原生业务页面。

## 构建与 Android Studio

需要 Node >=22.12、JDK 21、Android SDK 35、平台工具与 Android Studio 模拟器。设置 `JAVA_HOME` 与 `ANDROID_HOME` 后：

```powershell
npm run package:android
npm run android:open
```

构建脚本也识别本机 `.android-tools/jdk`、`.android-tools/sdk` 和 `.android-tools/gradle`。这些工具、Gradle 缓存、本地 SDK 路径和开发签名全部被 Git 忽略。使用 Android Studio 的 Device Manager 启动 Android 35 模拟器后，可直接运行 App 并查看 Logcat、布局和 WebView。

开发产物为 `releases/CHAOS-Android-<版本>-debug.apk`，仅含应用代码和界面，不含工作目录。未配置发行签名，不将开发 APK 当作商店发行包。Gradle 默认只构建 `:app` 自身与其测试包，不构建 Capacitor 依赖内部的测试 App。

## 可重复的自动验收

```powershell
npm run check
npm run package:android
npm run test:android
```

`test:android` 默认只连接已启动的 `emulator-*` 设备；实体手机需显式指定 `ANDROID_SERIAL`。脚本只允许使用 `Documents/CHAOS-Android-Test`，拒绝在已连接的个人目录运行写入测试。

闭环由现成工具组成：adb 安装／启动 APK；Playwright 通过调试 WebView 操作真实页面；系统 UI Automator 完成 SAF 授权；AndroidJUnitRunner 验证真实文件提供方。CDP 使用 `noDefaults`，避免向 WebView 发送其不支持的浏览器下载配置。

验收包含目录授权、项目／业务线／节点／待办创建、切线、Notes、关闭网络后的实际与完成联合保存、回顾、手动备份、强制终止后离线重启，以及真实 SAF 的 15 处发布中断恢复、第三种内容冲突、路径越界、严格 UTF-8 与目录独占。原生测试只在明确的合成目录内运行。

截图、原生测试输出与 JSON 结果写入 `test-results/android/`。浏览器手机回归见 `tests/e2e/mobile-ui.spec.ts`；共享业务适配回归见 `tests/android-runtime.test.ts`。没有执行的真机、磁盘满、实际断电和其他提供方测试必须在交付中区分说明。

修改 UI 后运行 `npm run android:sync` 复制网页资产；纯界面迭代也可先在预览入口闭环，再打 APK 进行键盘、系统栏、返回键和权限验证。

## 2026-11-03 本机验证记录

- `npm run check`：架构边界、149 项单元测试、TypeScript／Vite 构建和 61 项浏览器回归通过。
- Android 35、Pixel 7 x86_64、WHPX 模拟器：真实 SAF 授权，项目／业务线／节点／待办、实际滑动切线、Notes、断网实际保存、手动备份与恢复、强制终止后离线重启通过。
- `DocumentStoreTest` 四项原生测试通过，包括 15 个发布位置的中断恢复与第三种内容冲突保护。输出与截图在 `test-results/android/`。
- Windows 实际发布 ZIP 的 Electron 启动、四页、保存、配置恢复、隔离及 SQLCipher 验收通过。
- 电脑预览安装 EXE：独立目录安装、六页切换、完成／Notes／实际保存、重启保留内容和卸载保留额外文件验收通过。
- 开发 APK 已检查包内路径并生成 SHA-256；未执行发行签名、实体手机、真实断电、磁盘满或其他文件提供方验收。联网依赖审计按用户要求跳过。
