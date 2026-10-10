# 知创工坊：未调用代码审计

审计日期：**2026-10-09（Asia/Hong_Kong）**

## 1. 结论与口径

- 检查了 **64 个业务 TS/TSX 文件、6 份 CSS、2 个 public 资源**，并把测试、Vite 配置、Node 生产入口纳入交叉引用检查。
- **12 个导出符号没有任何仓库内调用/读取：src 下 9 个，server 下 3 个。** 其中有 2 个完整 TS/TSX 模块不在生产入口依赖图中。
- 另有 **1 份整文件 CSS、2 组旧 CSS 类、1 个历史 Word 模板** 未接入当前界面/导出。
- **7 个旧符号仅测试使用或只能经未接入组件/旧函数到达**，与“全仓零引用”分开列出。
- **4 个后端接口没有当前前端调用**，但仍注册在 HTTP 中间件中，有历史/兼容用途；不能据此宣称无人使用或直接删除。
- **未修改或删除业务源码。** 本次只新增本审计目录中的报告、分析脚本、证据与截图。

### 判定等级

1. **A：零调用/零引用**——TypeScript 符号解析未发现生产、测试、工具中的实际引用，不把声明、import 声明、类型声明或同名的其他符号算成调用。
2. **B：生产链不可达 / 只有测试**——可能有代码引用，但没有从 `src/main.tsx`、`server/index.ts`、`vite.config.ts` 到达的业务链。
3. **C：当前前端未接接口**——HTTP 路由本身仍是一个入口；静态代码不能证明仓库外客户端/运维脚本没有请求。

组件完全没有被挂载时，**它不可能在当前页面上有真实位置**。图片中绿框是现行入口/功能位置（仍在使用），红框是旧组件隔离预览；不是把可用的按钮标成“无调用”。

## 2. 前端：9 个零引用导出

| 编号 | 符号 | 定义位置 | 判定 / 注意点 |
|---|---|---|---|
| F1 | `InventionWorkspace`（旧发明专利四步工作区） | [src/features/invention/InventionWorkspace.tsx:27](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/InventionWorkspace.tsx:27) | 没有 import / JSX 挂载。主应用改用 UtilityNaming 与 UtilityWorkspace。整文件脱离生产入口。 |
| F4 | `isPlanResponse`（旧绘图响应校验器） | [src/features/utility/aiDrawing.ts:49](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/aiDrawing.ts:49) | 无引用；aiDrawing.ts 本身并非全废，后端还调用 isPlanInput、isDrawingPlan、planSource。 |
| F4 | `GEOMETRY_EXAMPLE`（旧手动几何示例） | [src/features/utility/contentDrawing.ts:55](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/contentDrawing.ts:55) | 无读取；同文件 GEOMETRY_HELP、GEOMETRY_FORMAT 仍在服务端提示词中使用。 |
| F4 | `contains`（图纸包围盒包含判断） | [src/features/utility/drawingModel.ts:394](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/drawingModel.ts:394) | 无调用；同文件实际绘图函数仍被使用。 |
| F4 | `alignFigureSpecsToRenderedModel`（旧图纸视图对齐兼容入口） | [src/features/utility/figureConsistency.ts:25](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/figureConsistency.ts:25) | 无调用，函数目前只 return model；不能连带删除 actualFigureMarkers。 |
| F2 | `productCore`（旧产品核心词提取） | [src/features/utility/naming.ts:69](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/naming.ts:69) | 没有调用；materialCores 只供它使用，也跟随闲置。 |
| F2 | `generateNames`（旧规则取名器） | [src/features/utility/naming.ts:364](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/naming.ts:364) | 注意：这是 naming.ts 的导出；UtilityNaming.tsx 内部的同名局部函数仍被按钮调用。 |
| F2 | `RULE_VERSION`（旧取名规则版本常量） | [src/features/utility/naming.ts:42](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/naming.ts:42) | 没有读取；不是函数，不应把“零引用”写成“零函数调用”。 |
| F4 | `emptyStructureDraft`（空结构草稿构造器） | [src/features/utility/structureDraft.ts:57](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/structureDraft.ts:57) | 无调用；同文件结构校验器仍有生产使用。 |

### F1 的关键证据

- [src/App.tsx:670](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/App.tsx:670) 的发明路由：确认名称后渲染 `UtilityWorkspace`，否则渲染 `UtilityNaming`，均传入 `patentType="invention"`。
- [src/features/invention/InventionWorkspace.tsx:27](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/InventionWorkspace.tsx:27) 没有生产 import，也没有 JSX 使用。
- 浏览器打开现行发明入口后，确认有 `.utility-naming[data-patent-type="invention"]`，没有 `.invention-workspace`；网络资源中也没有请求旧组件或旧 CSS。
- [src/features/invention/invention.ts:58](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/invention.ts:58) 的 `makeInventionMaterials` 随旧组件失去业务入口，但它有测试引用；`invention.ts` 的校验函数以及 [src/features/invention/wordExport.ts:8](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/wordExport.ts:8) 的旧数据 Word 导出仍在应用中使用，**不能删除整个 invention 目录**。

### F2 的同名函数误判排除

现行调用链为：

`按钮 onClick` → [UtilityNaming 内部 generateNames](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/UtilityNaming.tsx:315) → [POST /api/utility/naming-names](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/UtilityNaming.tsx:326) → 后端 `generateNamingNames`。

它与 [naming.ts 导出的 generateNames](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/naming.ts:364) 是两个不同的符号。后者无调用；不要删除现行取名按钮。仅供旧函数使用的 `directions`（:225）、`materialCores`（:68）也不在当前业务执行链中。

## 3. 前端：未接入的样式与历史资源

| 项目 | 位置 | 证据与处理边界 |
|---|---|---|
| 旧发明工作区整份样式 | [src/features/invention/invention.css:1](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/invention.css:1) | 唯一 import 位于已不可达的旧 InventionWorkspace.tsx:8；不由主应用加载。 |
| `.uw-copy-panel` | [src/features/utility/workspace.css:12](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/workspace.css:12)，:55–58 | TS/TSX 中无此 class；属于旧文案编辑面板。:12、:55、:56 与其他选择器合并，不能直接删除整条规则。 |
| `.uw-model-controls` | [src/features/utility/workspace.css:45](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/workspace.css:45)–50 | TS/TSX 中无此 class；对应旧模型控制区。当前绘图页也没有这个 DOM。 |
| 历史 `utility-standard.docx` | [public/templates/utility-standard.docx](C:/Users/zyun5/Desktop/知创工坊/知创工坊/public/templates/utility-standard.docx) | 无前端加载、无服务端读取；[docs/utility-word-standard.md:116](C:/Users/zyun5/Desktop/知创工坊/知创工坊/docs/utility-word-standard.md:116) 明确说明不参与当前导出。它仍可能被直接 URL 下载，不能证明外部引用为零。 |

当前模板中心在 [src/App.tsx:964](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/App.tsx:964) 使用 `create(c.id)` 创建项目，不读取这个历史 Word 文件。当前 Word 是由代码调用 `docx` 库生成。

CSS 检查是保守的类名静态匹配加实际 DOM 核对；没有把每个未出现于本次截图的伪类、媒体查询、后代选择器一概判为死码。

## 4. 后端：3 个零引用导出

| 编号 | 符号 | 定义位置 | 判定 / 注意点 |
|---|---|---|---|
| B3 | `sortIssuesBySeverity`（审稿问题排序函数） | [server/documentReviewer.ts:466](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/documentReviewer.ts:466) | 无调用；其他审稿及问题过滤函数仍被真实文档生成链路使用。 |
| B2 | `registerMaterialsV2Api`（未使用的 Express 风格注册器） | [server/materialsV2Api.ts:179](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:179) | 没有调用；实际 Vite/Node 服务使用 handleMaterialsV2Request，不使用 Express 注册。 |
| B1 | `buildFallbackStructureDraft`（旧确定性结构降级生成器） | [server/structureFallback.ts:22](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/structureFallback.ts:22) | 所在 structureFallback.ts 整文件无生产/测试入口；clean、uniqueName 也只有这条死链的内部引用。 |

### B2：不要把正在工作的 V2 接口误删

- 未调用的是 [registerMaterialsV2Api](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:179)，不是整个 materialsV2Api 模块。
- 现行入口是 [server/drawingAi.ts:18](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/drawingAi.ts:18) 导入的 [handleMaterialsV2Request](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:376)；POST 在 [server/drawingAi.ts:217](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/drawingAi.ts:217) 调用，GET 状态在 [server/drawingAi.ts:206](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/drawingAi.ts:206) 调用。前端发起位置分别是 [src/features/utility/UtilityWorkspace.tsx:233](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/UtilityWorkspace.tsx:233)、[src/features/utility/UtilityWorkspace.tsx:246](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/UtilityWorkspace.tsx:246)。
- 未使用注册器内部的 `readAiConfig`（[server/materialsV2Api.ts:39](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:39)）也只在这条死链中；这不是服务实际使用的 drawingAi.ts 的同名配置函数。
- 注册器里的 DELETE 取消路由（[server/materialsV2Api.ts:287](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:287)）**没有被挂载**，而且即使挂载，其实现也只返回“取消功能待实现”。当前中间件对 status 子路径只允许 GET。
- 每小时清理 `generationTasks` 的 `setInterval`（[server/materialsV2Api.ts:309](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/materialsV2Api.ts:309)）也只写在这个未调用的注册器内，因此**这段自动清理没有启用**。若这项行为仍需要，应迁移到现行服务生命周期，不能只把旧注册器删掉就认为任务清理仍在工作。

## 5. 只有测试 / 旧链路可达的 7 个符号

这些项**不是全仓零引用**。如后续清理，需要一起处理相关测试或先明确兼容需求。

| 符号 | 位置 | 实际情况 |
|---|---|---|
| `makeUtilityMaterials` | [src/data.ts:254](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/data.ts:254) | 只有测试调用；现行 UI 改为服务端 materials-v2，Word 导出要求 V2 冻结文案。 |
| `defaultUtilityParts` | [src/data.ts:184](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/data.ts:184) | 数组只有测试读取；导入模块时仍会执行初始化 .map，不是“绝不执行”的代码。 |
| `isDrawingCurrent` | [src/features/utility/contentDrawing.ts:112](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/contentDrawing.ts:112) | 只有测试调用；当前工作区使用自己的版本 / 来源一致性判断。 |
| `buildPatentStructureModel` | [src/features/utility/patentStructure.ts:233](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/patentStructure.ts:233) | 只有测试调用；当前结构主链走结构骨架、草稿规范化和离线编译。 |
| `nextDraftComponent` | [src/features/utility/structureDraft.ts:60](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/structureDraft.ts:60) | 只有测试调用，用于旧草稿编号逻辑验证。 |
| `makeInventionMaterials` | [src/features/invention/invention.ts:58](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/invention/invention.ts:58) | 有旧 InventionWorkspace 和测试的引用，但前者不可达，所以当前业务入口不可达。 |
| `selectParentClaim` | [src/features/utility/claimDependencies.ts:8](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/features/utility/claimDependencies.ts:8) | 仅由 makeUtilityMaterials 引用，随后仅从旧材料测试链路可达；不是字面零引用。 |

测试引用文件与位置已保存于 [static-analysis.json](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/static-analysis.json)，跨死链的依赖证据见 [reachability-analysis.json](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/reachability-analysis.json)。

## 6. 当前前端未调用的 4 个 HTTP 接口

已核对前端发起的 8 个不同接口路径。以下 4 个路径仍在 [AI_PATHS](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/drawingAi.ts:23) 中注册，不是未导入函数：

| 路径 | 定义 | 当前状态 |
|---|---|---|
| `/api/utility/drawing-plan` | [server/drawingAi.ts:21](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/drawingAi.ts:21) | 旧绘图计划接口，保留服务端协议/安全测试。 |
| `/api/utility/innovation-candidates` | [server/patentStructureAi.ts:22](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/patentStructureAi.ts:22) | 旧创新候选 API，当前前端不调用，服务端仍保留处理逻辑及测试。 |
| `/api/utility/structure-plan` | [server/patentStructureAi.ts:23](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/patentStructureAi.ts:23) | 已退役的兼容响应入口；进入对应处理分支会抛出 HTTP 410（RETIRED_ENDPOINT）。 |
| `/api/utility/structure-draft` | [server/patentStructureAi.ts:24](C:/Users/zyun5/Desktop/知创工坊/知创工坊/server/patentStructureAi.ts:24) | 旧草稿生成 API，有测试和 live-structure-smoke 工具使用；当前 UI 改走 structure-skeleton。 |

[docs/ai-drawing.md:11](C:/Users/zyun5/Desktop/知创工坊/知创工坊/docs/ai-drawing.md:11) 与 [docs/TESTING.md:73](C:/Users/zyun5/Desktop/知创工坊/知创工坊/docs/TESTING.md:73) 明确说明旧 drawing-plan 为协议兼容和历史测试保留。完整 12 个接口的定义、前端调用点、测试引用见 [routes-analysis.json](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/routes-analysis.json)。

## 7. 页面存在但不调用后端：不是死代码

- **资料库**：[src/App.tsx:982](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/App.tsx:982) 只把选择文件的名称、大小加入页面 state；页面已提示“不上传内容，刷新后清空”。它有 onChange / onClick，没有文件上传 API，是明确的本地预览功能，而非没有调用的组件。
- **模板中心**：[src/App.tsx:964](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/App.tsx:964) 的按钮有事件处理并进入创作流程；“不读取历史 docx”不等于“模板中心没有调用”。
- **访客工作空间**：[src/App.tsx:660](C:/Users/zyun5/Desktop/知创工坊/知创工坊/src/App.tsx:660) 明确标注未连接账户服务。用户界面仍有本地交互，不属于本次 A 类清理名单。

## 8. 前端位置图片

### 8.1 入口总览

![前端入口与闲置内部实现的对应位置](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/01-frontend-entry-map.png)

### 8.2 当前发明页面：仍在使用

![当前发明路由实际使用 UtilityNaming](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/02-current-invention.png)

### 8.3 真正未挂载的旧组件：隔离预览

![旧 InventionWorkspace 的真实隔离渲染，非当前业务入口](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/03-orphan-invention.png)

### 8.4 取名区域

![现行取名按钮与已闲置旧取名函数的区别](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/04-naming-location.png)

### 8.5 绘图与结构区域

![绘图区域以及旧辅助函数和样式的对应功能位置](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/05-drawing-location.png)

### 8.6 申请材料区域

![现行 V2 文案入口、历史生成器和模板的区别](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/06-materials-location.png)

## 9. 方法、验证与限制

1. 从前端 main、生产 server/index、开发/预览 vite.config 三个入口构建静态 import 图，区分运行时 import 与 type-only import。未发现运行时 `import()` / `import.meta.glob` / `require` 这类动态载入入口；src/data.ts 的 `import(...)` 是类型表达式。
2. 使用项目自带 TypeScript 编译器 API 做符号身份解析，区分同名函数，检查声明外引用，并将测试引用与生产引用分开。随后对候选逐项检索和人工核对，追踪被死函数引用的辅助声明。
3. 核对 6 份样式、public 资源和 API 路径；检查 HTTP 注册、回调、JSX 等不能只靠名称搜索判定的入口。
4. 在隔离的 Edge 无头浏览器中运行真实应用。命名/骨架使用仓库现有测试夹具，只有本地 compile-structure 请求进入服务；外部 AI / 检索调用 **0 次**，未访问用户现有浏览器数据。
5. 主应用未挂载旧组件；为满足外观展示，专门在本审计 artifacts 目录下建立了隔离预览。**该预览导入不属于业务调用，也没有改动应用路由。**
6. 验证：TypeScript 应用检查通过（退出码 0）；Playwright 审计场景 **1 passed**；浏览器 JS 错误 **0**。这不是全项目测试或线上流量审计。
7. 源码完整性：对 70 个 src/server 文件进行 SHA-256 前后比对，变更文件 **0**。
8. 没有生产访问日志，无法推断项目外部调用；类型声明、第三方依赖、构建产物、测试本身没有被笼统列为“死代码”。源码变更后结论应重新计算。

### 审计证据与复查脚本

- [导出符号 / 引用证据](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/static-analysis.json)
- [入口可达性 / 跨死链依赖](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/reachability-analysis.json)
- [CSS / public 资源证据](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/asset-analysis.json)
- [12 个 API 的前后端对照](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/routes-analysis.json)
- [浏览器断言与请求记录](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/browser-evidence.json)
- [验证汇总与源码完整性](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/verification.json)
- [符号扫描脚本](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/audit-symbols.mjs)、[可达性扫描脚本](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/audit-reachability.mjs)、[资源扫描脚本](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/audit-assets.mjs)、[真实页面截图脚本](C:/Users/zyun5/Desktop/知创工坊/知创工坊/artifacts/unused-audit-2026-10-09/capture.spec.ts)

## 10. 清理顺序建议（本次未执行）

1. 优先确认不再需要旧发明工作区、旧规则取名器与独立的 structureFallback 模块，再清理零引用函数/常量及其仅内部使用的助手。
2. 清理未使用样式和历史模板前，确认是否需要保留设计/历史资料；合并 CSS 选择器要拆分处理。
3. 对 Express V2 注册器先决定取消接口与过期清理的归属，再删旧注册代码；保留在用的 Connect/Node 处理器。
4. 测试专用旧接口、旧数据 Word 导出与公开 HTTP 兼容入口最后单独评估，不与 A 类零引用代码一起直接删除。
