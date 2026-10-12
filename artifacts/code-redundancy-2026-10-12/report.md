# 知创工坊冗余代码检查

本报告记录清理前的发现。已于 2026-10-12 完成无用代码清理；处理结果和最终验证见 [cleanup-summary.md](cleanup-summary.md)。`inventory.json` 为清理后的依赖扫描结果。

检查日期：2026-10-12。检查的是当前工作目录，包含检查前已有的未提交修改。

结论：存在明确的旧流程残留、未调用的函数和常量，以及少量重复实现。最明显的是主界面已经切换到 ProductWorkflowWorkspace，旧工作区及其辅助文件仍被保留。

## 检查范围与方法

- 扫描 `src/`、`server/`、`tests/` 和根目录配置、诊断脚本，共 152 个 JS/TS 文件，其中应用源码 74 个；另检查 7 个 CSS 文件。
- 从 `src/main.tsx`、`server/index.ts` 和 `vite.config.ts` 建立静态依赖图，区分运行时引用与类型引用。
- 使用 TypeScript 符号解析核对导出成员的调用，包含同文件调用、别名导入、测试和旧组件中的引用。只看“有没有外部 import”会误判大量仍在本文件使用的函数，本报告没有采用这种判断。
- 对函数体和连续代码块做重复扫描，并核对下载流程、测试夹具、部署配置、文档和静态资源引用。
- 排除 `node_modules/`、`dist/`、测试报告和 `artifacts/` 中的历史快照：它们不是当前运行源码。
- `tsc -b --pretty false` 通过；`npm run lint -- src server tests` 通过，仅有旧工作区混合导出函数和组件的 Fast Refresh 警告。
- 本次没有删除业务源码，也没有执行完整端到端测试或调用付费 AI。旧 UI 测试的过时判断来自入口和选择器对照，并非本次运行失败的结果。

## 1. 当前入口无法到达的旧流程：5 个源码文件 + 2 个样式文件

`src/App.tsx:661` 和 `src/App.tsx:669` 中，发明与实用新型均渲染 `ProductWorkflowWorkspace`。旧 `UtilityWorkspace` 和 `InventionWorkspace` 没有被主界面导入，也没有动态导入入口。

| 文件 | 依据 | 建议 |
| --- | --- | --- |
| `src/features/utility/UtilityWorkspace.tsx:68` | 没有组件调用；内部仍保留旧附图、结构模型、V2 文案流程 | 优先删除或移到历史存档 |
| `src/features/utility/PatentStructureFlow.tsx:95` | 只有上述旧工作区调用 | 与旧工作区一并整理 |
| `src/features/utility/PatentResearchView.tsx:3` | 只有上述旧工作区调用 | 与旧工作区一并整理 |
| `src/features/utility/namingStructureInput.ts:6` | 只有上述旧结构流程调用 | 与旧工作区一并整理 |
| `src/features/invention/InventionWorkspace.tsx:27` | 没有任何组件调用，旧手工事实输入流程已被替代 | 优先删除或移到历史存档 |
| `src/features/utility/workspace.css:1` | 仅由旧 UtilityWorkspace 导入 | 随旧组件整理 |
| `src/features/invention/invention.css:1` | 仅由旧 InventionWorkspace 导入 | 随旧组件整理 |

5 份源码约 1,018 行，2 份样式约 244 行，合计约 1,260 行。

这批文件本来就不在当前浏览器入口的依赖链中。清理主要减少维护成本、搜索干扰和过时文档，不应声称删除后会显著加快现有页面。

## 2. 没有调用的函数和常量

符号扫描找到 12 个没有实际引用的运行时导出，其中 2 个就是上述旧工作区组件；其余 10 个如下。

| 位置 | 导出成员 | 判断 |
| --- | --- | --- |
| `src/features/utility/naming.ts:364` | `generateNames` | 旧的本地规则定名算法，当前页面调用服务端 AI 定名；页面中同名的局部函数是另一个函数，不能误删 |
| `src/features/utility/naming.ts:69` | `productCore` | 未被本文件、其他源码或测试调用 |
| `src/features/utility/naming.ts:42` | `RULE_VERSION` | 未使用常量 |
| `src/features/utility/aiDrawing.ts:49` | `isPlanResponse` | 旧方案响应校验函数，没有调用 |
| `src/features/utility/contentDrawing.ts:55` | `GEOMETRY_EXAMPLE` | 未使用的示例字符串 |
| `src/features/utility/drawingModel.ts:394` | `contains` | 未使用的包围框判断函数 |
| `src/features/utility/figureConsistency.ts:25` | `alignFigureSpecsToRenderedModel` | 无调用，函数体仅原样返回输入模型 |
| `src/features/utility/structureDraft.ts:57` | `emptyStructureDraft` | 未使用的空草案工厂 |
| `src/features/product/productPrompts.ts:11` | `PREVIEW_TEMPLATE_IDS` | 只在 productWorkflow.ts 再导出，没有实际消费 |
| `src/features/product/productPrompts.ts:19` | `COLOR_PREVIEW_TEMPLATE_V1` | 旧单张三视图提示词；注释称用于历史核对，但当前没有核对代码读取它 |

`naming.ts:225` 的 `directions` 行业映射只被未调用的 `generateNames` 使用，其相关 `Direction` 类型可以随算法一起清理。应保留 `validateProfile`、`checkName`、`checkProduct` 等仍被前端、服务端及测试使用的公共校验函数。

另有 21 个导出成员的引用只来自测试或旧组件。它们属于进一步核对清单，不等于可以直接删除；完整候选及引用位置见 `inventory.json` 的 `nonProductionSymbols`。

## 3. 可以合并的重复实现

### 服务端引用哈希

`server/patentResearch.ts:24` 与 `server/researchProvider.ts:12` 的 `stableCitationHash` 函数体完全相同。建议提取到共享模块，避免引用 ID 的算法今后只修改一处。

不要和 `src/features/product/digest.ts` 的 SHA-256 合并成同一种算法：两者用途和算法不同。

### 浏览器文件下载

`src/App.tsx:298`、`:309`、`:317`、`:329` 和 `src/features/product/ProductWorkflowWorkspace.tsx:213` 重复执行创建 Blob URL、创建链接、触发下载和延时释放 URL。旧工作区里也各有一份。

建议提取 `downloadBlob(blob, filename)`。调用方继续负责文档生成、权限/数据校验和成功提示，只共享下载动作。

`src/App.tsx:1181` 与 `:1258` 还重复通过立即执行函数调用 `validateInventionMaterials` 来判断同一预览项目是否可以导出，可以计算一次布尔值供预览提示和按钮共用。

### 测试夹具

以下三个函数的主体完全一致，都编译同一个示例结构、确认事实并创建生成上下文：

- `tests/utility-claim-text-grounding.spec.ts:10` 的 `fixture`。
- `tests/utility-generation-context.spec.ts:146` 的 `contextFixture`。
- `tests/utility-materials-v2-api.spec.ts:11` 的 `contextFixture`。

建议提取到公共 fixture；保留各自断言，不能因为输入相同就删除不同场景的测试。

还发现少量重复的测试网络拦截和诊断输出代码，具体函数匹配见 `inventory.json` 的 `duplicateFunctions`。扫描没有发现长度至少 450 字符、连续 10 行完全相同且涉及生产源码的跨文件代码块；这不排除参数、变量名或排版不同的语义重复。

## 4. 临时脚本和未参与导出的静态资源

- 根目录 `tmp-diag-diff.ts`、`tmp-diag-options.ts`、`tmp-diag-sweep.ts` 没有 package.json 入口，也没有运行源码引用，且被 `.dockerignore` 排除。用途是手工诊断定名 API，建议移入 `scripts/diagnostics/`，按需要保留；其中后两个脚本的抓取模型响应函数完全重复。
- `public/templates/utility-standard.docx` 约 23.8 KB，源码没有读取或下载它。`docs/utility-word-standard.md:116` 也明确说明当前导出不使用它。Vite 仍会把 public 文件复制到构建产物；如果还要留作历史参考，建议移到文档存档而不是公开资源目录。不能仅凭内部无引用断言外部用户从未直接访问该 URL。
- `artifacts/` 中的历史源码快照、基线和评估产物主要属于存档体积，不是正在执行的重复代码。不要批量删除，先确定哪些记录还需留存。

## 5. 旧测试、旧文档与已保留 API

- `tests/utility-ai-workspace.spec.ts:6` 仍要求 `patent-structure-flow` 出现；它只在当前未接入的旧组件中渲染。
- `tests/utility-workspace.spec.ts:17` 及 `tests/fixtures/structureFlow.ts:90` 仍使用旧结构骨架、旧页签和“按名称生成结构”按钮。相关 UI 场景应迁移到当前产品流程；同一测试文件中的纯模型/兼容性校验不应一起删掉。
- `docs/patent-generation-dataflow.md`、`docs/utility-workspace.md` 和 `docs/TESTING.md` 部分内容仍把旧工作区描述为主流程，整理组件时应同步更新。
- `/api/utility/materials-v2`、结构骨架、结构草案和绘图方案等旧接口依然在 `server/drawingAi.ts` 注册。部分接口仅被旧 UI 或测试使用，但服务端仍是可访问 API；应先确定外部客户端兼容要求，再决定下线实现。
- `structure-evidence-options` 仍被当前 `UtilityNaming` 使用，不能因名称属于旧结构流程就整体删除结构相关服务。
- `structure-plan` 已明确退役，保留拒绝旧请求的响应可能有兼容作用，不宜把这类防护入口自动视作无用代码。

## 6. 明确应保留的代码

- `src/features/product/digest.ts:20` 的 `sha256Sync` 被同文件 `sha256Hex` 调用。局域网 HTTP 中 `crypto.subtle` 可能不可用，这段降级算法是实际需要的代码。
- `src/features/product/productWordExport.ts` 的 `patentImageForWord`、`cadFigureForWord` 在本文件内被调用，并非无用导出函数。
- 旧发明/实用新型材料的导出和校验仍通过 `App.tsx:305`、`data.ts` 以及项目读取逻辑接入；删除旧 UI 不代表能删除所有旧数据类型、渲染和 Word 导出逻辑。
- IndexedDB 对 localStorage 的迁移、失败恢复仍有明确用途。
- `tests/support/namingOneShotLive.mjs` 虽未被生产代码引用，但已有显式 npm 脚本入口，属于评估工具。
- 当前 package.json 中的运行依赖均有使用，没有发现明确可删除的运行依赖。

## 建议整理顺序

1. 整理 5 份脱离入口的旧源码、2 份关联 CSS，以及 10 个未使用函数/常量；同步处理旧算法私有映射和文档。
2. 合并哈希函数、下载动作和重复测试夹具，保持原有行为。
3. 迁移已过时的 UI 测试；验证当前产品流程和旧项目读取/导出。
4. 最后决定是否下线旧 API、如何归档诊断脚本、模板和历史产物。

删除源码后应重新运行类型检查、lint、当前产品流程测试以及旧项目导出回归；需要发布时再重新构建 Docker 服务。
