# 主应用专利文本流程

2026年10月14日，按照与用户梳理的完整流程重构主应用。默认入口只需输入产品名，由 `/api/product/problems` 提出候选问题，用户选择一项后自动命名并进入既有产品工作区。补充描述和企业名称可选，零件、连接、位置和工作过程由系统确定。已有特征拟名界面作为可选入口及历史项目编辑方式保留。

独立 `patent-text-app` 作为规则和历史样稿来源，主应用不导入该原型代码。预览、生图、CAD、附图确认及 Word 附图打包保持既有路径。

## 调用与保存

现有 `/api/product/review` 仍负责跨特征逻辑检查。之后自动执行：

1. `/api/product/structure`：生成统一技术资料，保存签名的 `workflow.textStructure`。
2. `/api/product/brief`：复核并原子应用部件修改，保存 `brief.technicalSource` 的原方案、修改记录、冻结方案与内容版本；从该方案派生原有 `design` 和 `description`。
3. 保持已有预览、用户确认、CAD/备用黑白图调用流程。
4. `/api/product/draft`：由冻结技术资料生成权利要求、说明书及摘要，保存签名的 `workflow.textDraft`。
5. `/api/product/materials`：复核正文，应用文字补丁；通过 `documentContent` 映射回既有展示与 Word 字段，附图说明仍按原附图登记表拼接。

四个文本阶段各一次正常模型调用。沿用 `productJson` 的服务商切换、单次超时、一次格式修正及取消机制。前端逐阶段保存，失败或页面重载后复用当前版本的检查点；直接调用原有 brief/materials 接口的客户端也可自动执行缺少的前阶段。进程内缓存按签名区分，不能替代持久保存的检查点。

选题保存在 `NamingRecord.problemProposal / problemSelection`，转换为 `ProductSelection.selectedProblem`。场景、问题、目标原样进入结构方案并由程序核对，避免后续自行换题。新选题不要求结构证据确认，不把候选结构方向伪装成用户已有事实。

格式修正同时传入 `correction.previousOutput` 和具体错误，避免让模型仅根据错误消息重新设计整个结果。结构、结构复核、正文、正文复核的输出预算分别为9000、5000、11000、8000 token；文本请求单独使用低推理预算，既有生图及CAD调用参数不受影响。规则版本为 `2026-10-14-v2`，旧v1冻结资料仍可读取并核验。

“继续复核”提交已签名的 `previousMaterials`，检查简介与技术版本后在上次修正后的文稿上继续，而不是回到最初草稿。成功的前阶段和旧成果保留。

结构矛盾未解决时返回既有失败路径，保留结构检查点；正文复核未解决项保存在 `textRecord` 并显示“待复核”，可继续复核，未增加人工批准或质量评分。生成状态仍为原有 running/completed/failed/cancelled。完成表示初稿和复核流程完成，不是实施性或授权判断。

## 数据边界

`src/features/product/productText.ts` 定义及校验 schemaVersion 3：核心改进、保护对象、部件/局部特征、所属关系、连接、核心动作及通路依据、工作过程、直接效果和三层保护方案。场景假设和试验任务独立保存。

通用名称在 `parts.name`；可选 `parts.form` 存具体形式名称、具体结构与概括依据。名称对应稳定编号，不用任意同义词匹配。删除或重排部件不会重新编号；保留现有绘图接口最多12个实体部件的技术限制，最多30个结构标记，孔槽、局部部位及配合面通过其所属实体的描述传给绘图模块，不作为独立 CAD 实体。

结构复核仅允许 `partEdits` 按 `partId + partName` 修改部件。禁止 `/parts` 整体替换或下标路径；新增须用新编号，改名需同步关联术语。先克隆、应用整轮补丁并验证所有引用和所属关系，再保存。任何定位或引用错误均不提交部分结果。标题、选定场景、问题和目标不可通过复核补丁改变。

`technicalPlanForWriting` 在各层按字段白名单给正文及文本复核提供技术资料；排除设计假设、工程任务、私有记录及审查日志。不会用正则删除技术句子。`documentForWriting`、`documentContent` 和既有导出只处理正文字段。工作过程保存在 operation，最终只追加一次到具体实施方式；效果用自然句，摘要上限300字。

技术版本为规则版本与技术白名单内容的 SHA-256，浏览器和服务端使用同一算法。正文检查点及复核结果同时绑定 briefId 和技术版本。签名检查防止浏览器伪造阶段结果；内容变化后旧草稿不能复用，重新生成仅影响依赖阶段。旧材料及上一版工作区可继续读取，不批量覆盖历史文件。

历史简介没有 technicalSource 时，正文读取原有 design 的技术字段，不读取带设计记录的 description，也不重新发明结构。历史完整项目保持原有读取及导出行为；新生成任务使用新版本约束。

## 代码入口

- `server/productWorkflowAi.ts` 注册新检查点接口，保留附图路由。
- `server/productTextAi.ts` 组织四阶段、签名、缓存、版本、旧简介兼容和技术资料到现有简介的转换。
- `server/productTextPrompts.ts` 集中四阶段规则与 JSON 示例，替代主应用旧单次简介/正文提示词。
- `server/productJson.ts` 为原有文本模型调用公共实现，不改变模型配置来源。
- `src/features/product/ProductWorkflowWorkspace.tsx` 自动调用并保存检查点，复用现有项目存储、取消及重试。
- `src/features/product/productWorkflow.ts` 校验新旧记录，阻止旧版本文本导出；复制/TXT 不再附加产品简介。

## 验证

运行 `npx playwright test --config playwright.product.config.ts` 验证文本身份与版本、API、浏览器恢复及既有附图/Word行为；运行 `npm run build` 与 `npm run lint`。

本轮使用 `artifacts/product-text-context-refactor-2026-10-14/playwright.config.ts` 在独立端口启动构建后的主应用，覆盖新选题入口、历史拟名、文本版本、复核续接、Token累计及既有附图流程。测试中的模型和图片为明确模拟数据，不消耗实际生图额度。

实际文本模型测试：在 PowerShell 设置 `RUN_PRODUCT_TEXT_LIVE=1` 后运行 `node --experimental-strip-types --env-file-if-exists=.env.local tests/support/productTextLive.mjs`。脚本固定历史纸箱、夹具、闸门问题，各独立生成两次，调用主应用四个文本服务，不调用附图服务。前置名称和问题采用测试资料，不冒充已执行候选问题生成或前置逻辑审查。结果目录保存程序快照、耗时、服务商切换、修正、失败、完整技术资料及正文。缺少配置时直接报错，不伪造结果。
