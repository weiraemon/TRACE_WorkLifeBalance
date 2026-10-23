# 参与开发

Node >=22.12。在仓库根目录（`package.json` 所在目录）执行 `npm ci`、`npm run dev`。浏览器访问 http://127.0.0.1:4317。

先运行 `npm test`，再 `npm run build` 和 `npm run test:e2e`。Playwright 默认使用已安装的 Chrome；可设置 `ATLAS_BROWSER_CHANNEL=msedge`，或安装 Chrome：`npx playwright install chrome`。Windows 文件安全测试需要允许 NTFS 硬链接与 Junction 创建，受限沙箱会明确失败。

- 每次只完成一个真实业务闭环；不要引入没有使用场景的框架、发布包或第二套状态模型。
- 所有领域契约与校验放在 `packages/domain`，文件访问放在 local-service，界面仅调用 API。
- 新的写入方式先在随机临时 Vault 上测试，不拿用户现有 Vault 做实验。
- 测试不得放松冲突、正文保留、恢复、越界和实际时间不重叠断言。
- 修改共享 Schema 后检查样例、UI、测试和数据文档。不要无声迁移已有笔记。
- PR 必须写明真实验证结果、剩余限制，以及是否增加记录步骤。禁止将 Mock 原型描述为已完成业务。

集成测试在系统临时目录创建随机测试目录，E2E 在 `.test-vault` 创建随机 Vault；不指向用户 Vault。`scripts/sample-vault.ts` 仅接受空目录，防止覆盖样例以外的数据。

CI 在 Windows 上跑完整检查，使用 Edge；Linux 支持尚未作为发布保证。开源许可证 MIT，新增依赖核实其实际包许可证并提交 lockfile。
