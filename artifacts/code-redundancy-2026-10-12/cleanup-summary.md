# 无用代码清理结果

日期：2026-10-12。

已删除 13 个废弃文件，并清理旧工作区退役后没有调用的函数、常量、类型定义、测试辅助函数和页面用例。源码、脚本和测试合计净减少约 2,960 行；不包含本报告目录的审计工具和验证产物。

## 删除的文件

- `src/features/utility/UtilityWorkspace.tsx`
- `src/features/utility/PatentStructureFlow.tsx`
- `src/features/utility/PatentResearchView.tsx`
- `src/features/utility/namingStructureInput.ts`
- `src/features/invention/InventionWorkspace.tsx`
- `src/features/utility/workspace.css`
- `src/features/invention/invention.css`
- `tmp-diag-diff.ts`
- `tmp-diag-options.ts`
- `tmp-diag-sweep.ts`
- `public/templates/utility-standard.docx`
- `tests/utility-ai-workspace.spec.ts`
- `tests/live-materials-v2.spec.ts`

## 清理的声明与测试

- 删除旧本地 `generateNames` 算法，以及它独占的行业映射、类型和材料词表；保留页面中的 AI 定名操作及公共输入校验。
- 删除 `productCore`、`RULE_VERSION`、`isPlanResponse`、`GEOMETRY_EXAMPLE`、`contains`、`alignFigureSpecsToRenderedModel`、`emptyStructureDraft`。
- 删除仅供旧页面使用的 `consistencyIssueHint`、`applyConsistencyExemptions`、`FIGURE_NAMES`、两份骨架编辑选项。
- 删除没有消费方的 `PREVIEW_TEMPLATE_IDS`、旧彩色预览提示词及其再导出。
- 删除没有引用的 `PreviewViewId`、`FinalPatentPackage`、`PatentStructureResponse` 类型，以及因此失去用途的导入。
- 移除 37 个针对已退役页面的顶层测试块；保留同文件的模型、协议、材料门禁和历史 Word 校验。
- 删除旧页面专用的骨架/工作区/材料请求模拟与导航辅助函数；保留仍被模型测试使用的示例数据和材料生成夹具。
- 修复旧结构协议测试的模拟 fetch，使其覆盖当前检索协议要求的专利原文 GET；保持模型请求次数断言。
- 修正主模型定名与脱敏失败日志的过时断言。150 ms 预算用例同时接受最后一次响应未到达前超时与无效响应两种阻断结果，仍严格断言只有三个 provider 请求、没有后续修复请求。
- 普通 Playwright 配置排除要求专用网络守卫环境的三个测试文件；这些测试仍通过专用配置执行，没有删除。
- 更新当前数据流和工作区文档；历史测试记录明确标为旧版本记录。

## 保留依据

历史项目的数据类型、校验、读取、导出与旧 API 仍有入口或协议测试。局域网 HTTP 中使用的 SHA-256 降级实现、IndexedDB 迁移和 Node loader 的 `resolve` / `load` 钩子也仍需使用。重复但正在调用的实现属于可重构代码，未将其当作无用代码删除。

清理前已有的模型配置、网关配置、命名页面修改与评估记录保留在工作目录中。清理完成后，生产源码、配置与本清理记录一并提交 GitHub；本机密钥和原始测试运行产物保留在本地。

## 验证

- TypeScript 类型检查、Vite 生产构建、lint 和 diff 空白检查通过。
- 最新依赖扫描没有发现入口不可达的应用模块，或没有实际引用的运行时导出及类型定义。见 `inventory.json`。
- 扫描测试导出后仅出现两个由 Node loader 隐式调用的钩子，已确认其注册入口，予以保留。
- 473 个不同用例分组覆盖验证通过，汇总见 `validation.json`。
  - 普通回归覆盖 406 个用例：最后一次完整运行 405 个通过；一个 150 ms 平台调度断言修正后，单独重跑通过。
  - 106 个原文证据/接口边界专项用例全部通过。
  - 39 个查询覆盖专项用例全部通过。专项之间及与普通套件有重叠，不能把三组数量直接相加当成唯一用例数。
- 当前产品 UI 的 16 个用例通过，包括发明/实用新型定名、四视角、Word、移动端无障碍、旧签名恢复及非安全上下文兼容。
- 付费真实 AI 用例未运行。专项模拟测试按照原配置要求安装离线网络守卫，并把产物写入系统临时目录。

本次同时重新构建并更新 Docker 应用，检查容器健康状态、局域网网关首页与 JS/CSS 资源。已删除的旧模板地址返回 404；首页返回新版本并保留 `Cache-Control: no-cache`。

其他机器继续访问 `http://192.168.0.58/`，刷新即可加载更新。
