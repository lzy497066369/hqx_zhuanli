# 后端无引用代码清理

日期：2026-10-09

## 已执行

仅修改后端业务源码：2 个文件局部删除，1 个文件整文件删除，共删除 247 行，无新增业务逻辑。前端 src 目录未改动。

- 整文件删除：`C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/structureFallback.ts`（59 行）。
- [materialsV2Api.ts](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts)：删除未调用的 registerMaterialsV2Api 及专用 JsonResponse / JsonRequest / ExpressLike / 局部 readAiConfig（176 行）。
- [documentReviewer.ts](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/documentReviewer.ts)：删除无引用的 sortIssuesBySeverity（12 行）。

旧注册器中从未启用的取消占位实现、定时清理随注册器一并删除。本次不新增取消或任务回收行为。

在用的 handleMaterialsV2Request、convertV2ToV1Materials、任务状态与文档生成流程未改动。仍挂载的历史 HTTP 兼容接口与测试专用逻辑未删除。

## 验证结果

- TypeScript 完整项目检查：通过。
- 后端 oxlint：退出码 0。
- Vite 生产构建：通过。产物输出到本清理目录，未覆盖已有 dist；有 bundle 超过 500 kB 的体积提示。
- 相关回归：39 项，38 通过，1 失败。
- 失败项：[utility-ai-server.spec.ts:170](C:/Users/zyun5/Desktop/知创工坊/知创工坊/tests/utility-ai-server.spec.ts:170) 的产品方案接口集成测试，期待 HTTP 200、实际 502。
- 用删除前文件在隔离副本中复测：同一测试以同样的 502 失败，已确认不是本次删除引入。未扩大范围修改该接口或测试。
- 删除后重扫：server 中零引用导出 0 个、不可达模块 0 个。
- 源码哈希确认仅上述 3 个后端文件变化；AST 对照确认其余顶层语句内容未变。
- 测试只允许连接本机，外部 AI 请求 0 次。

## 备份与证据

- [删除前原始备份](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/backend-cleanup-2026-10-09/backend-before-cleanup.zip)
- [本次删除差异](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/backend-cleanup-2026-10-09/backend-cleanup.patch)
- [验证汇总](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/backend-cleanup-2026-10-09/verification.json)
- [回归测试结果](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/backend-cleanup-2026-10-09/test-results.json)
- [删除前基线复测结果](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/backend-cleanup-2026-10-09/baseline-test-results.json)

隔离基线副本保留在本审计目录中，仅作为删除前测试证据，不属于业务入口或生产源码。先前未调用审计报告是删除前快照，本文件记录实际清理结果。
