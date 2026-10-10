# 产品简介驱动的创作流程

## 当前默认链路

发明专利（产品型）和实用新型共用新的产品工作区。外观设计和软件著作权保留原有模板流程。

1. 填写企业名称、产品基础名称，选择产品方向、特征、改进类型及结构资料，确定初步名称。
2. 保存名称后，独立调用文本模型检查**所有已选特征、资料与初步名称**的逻辑关系。检查名称/客体、连接、运动、空间、材料/环境、功能条件、安全/制造边界七个维度。
3. 有实质矛盾时返回明确原因及可选的删除、替换、同步改名方案。用户逐项取舍后重新检查；不静默删特征，不直接放行互斥选择。合理缺省和需要工程核实的参数列为推定，不强制用户手工补结构或坐标。
4. 检查通过后另一次文本调用生成详细产品简介，包含用途、外形与配色、部件编号、形状、连接、工作过程、改进点、逐项特征落实及待核实事项。
5. 将这一份完整简介分别注入四个彩色视角模板，**并行**向生图接口提交四张预览：主体图（轴测）、前视图、俯视图、右视图。提示词同时要求按简介的部件编号在图中用细引出线标出 1、2、3……（数字放在产品外侧留白处）。每个视角只提交一次；某个视角失败时其余视角保留，重试只补缺失视图。预览只用于确认外形，精度要求不高。
6. 用户可确认或重画。重画弹窗包含输入框、方向选项、必要时的澄清问题；上下文保留前轮答案，信息足够便停止询问。没有问答轮数或重画次数上限。结构变更会再次进行逻辑检查并生成新的完整简介和四张新预览。
7. 明确确认**当前版本**的四张预览后，进入 CAD 阶段：
   - 浏览器把四张预览压缩到 1024 像素以内，与简介一起交给视觉模型；视觉模型输出一个 FreeCAD Python 脚本（只允许 `FreeCAD`、`Part`、`math`，必须定义 `build_model()`）。
   - 服务端对脚本做静态白名单校验（禁止文件、网络、GUI、反射、双下划线、顶层调用），不通过时让模型针对校验问题修正一次；两次都不通过就放弃，不执行任何代码。
   - 在隔离的临时目录里用 `freecadcmd` 执行受限脚本（受限 builtins + 只放行白名单 import + 超时强杀），得到统一三维模型的三角网格。
   - 用确定性的正交投影与隐藏线消除，从同一网格投影出立体图、前视图、俯视图、右视图四张矢量附图（SVG）。视觉模型在同一份 JSON 里为每个部件给出脚本坐标系中的外表面锚点（`labels`），服务端把锚点吸附到最近的可见网格顶点，在轮廓外侧留白处写数字、用细弧形无箭头引出线连到部件（样式参照用户提供的箱子附图）；可选的 `keyStructure` 在立体图上画圆圈并标 A。标号编号与简介部件编号、彩色预览中的编号一致。
   - 再按这份真实附图清单生成申请文案；附图说明与附图编号由服务端固定生成，不由文案模型编造。
8. 导出 `.docx`，包含摘要、权利要求书、说明书、四张由统一模型投影的黑白附图，以及供核对的完整产品简介、FreeCAD 建模脚本、建模推定与四张预览提示词。附件不属于正式申请正文。

**兜底路径：** 本机没有 FreeCAD、脚本两次都不合规或建模失败时，页面显示具体原因并保留已确认的预览；用户可明确点击“改用 AI 黑白结构图”，用用户提供的黑白结构图模板出一张 AI 图片，文案也按这份单图清单生成。不会静默降级，也不会混用两种来源的附图。

## 代码入口

- `src/features/product/ProductWorkflowWorkspace.tsx`：页面、去矛盾、重画澄清、四图预览确认、CAD/兜底成品、分阶段恢复。
- `src/features/product/productWorkflow.ts`：类型、数据校验、版本门禁、原始选择快照、持久化校验（`previews`、`cad` 与旧版 `preview` 兼容）。
- `src/features/product/productPrompts.ts`：四个彩色视角模板、黑白模板、附图登记表（`FIGURE_CATALOG`）与 CAD 视角定义。
- `src/features/product/productWordExport.ts`：SVG 附图栅格化与纯黑白化、预览压缩、Word 打包。
- `server/productWorkflowAi.ts`：文本提示词、逻辑检查、完整简介、重画澄清、并行预览、CAD 路由、按附图清单生成文案。
- `server/productCad.ts`：视觉提示词、脚本静态校验、FreeCAD 探测与隔离执行、附图投影、签名。
- `server/meshFigure.ts`：三角网格正交投影 + 深度缓冲隐藏线消除 → SVG，无外部依赖，可离线测试。
- `server/productImages.ts`：独立图片服务凭据、单次生图调用、图片下载及安全限制。
- `server/productProof.ts`：服务端 HMAC 结果签名与版本校验。
- `server/drawingAi.ts`：本机 API 中间件和配置读取。

原来的结构模型编译、几何绘图与 V2 文案工具仍保留，用于旧数据与相关代码的兼容；它们不再是新产品流程的前置门禁。旧版单张三视图预览（`preview` 字段）打开后仍保留显示，但不能用于确认，需要重新生成四张预览。

## 服务端配置

仅使用 `.env.local`，不要使用 `VITE_` 前缀。现有文本模型配置保持不变：

```dotenv
AI_IMAGE_BASE_URL=https://api.psydo.top/v1
AI_IMAGE_MODEL=gpt-image-2.5
AI_IMAGE_API_KEY=填写具有生图权限的服务端密钥
AI_IMAGE_SIZE=
AI_WORKFLOW_SIGNING_KEY=

# 视觉模型：不填则复用 AI_MODEL（必须支持 image_url 输入）
AI_VISION_MODEL=
AI_VISION_BASE_URL=
AI_VISION_API_KEY=
# FreeCAD 命令行程序；不填则自动探测 PATH、%LOCALAPPDATA%\Programs、Program Files 等常见位置
FREECAD_CMD=
FREECAD_TIMEOUT_MS=300000
```

FreeCAD 安装：Windows 执行 `winget install FreeCAD.FreeCAD`（本机已安装 1.1.4，路径 `%LOCALAPPDATA%\Programs\FreeCAD 1.1\bin\freecadcmd.exe`）；Linux 可用发行版包或 AppImage；macOS 为 `FreeCAD.app/Contents/Resources/bin/FreeCADCmd`。更改环境配置后重启开发/生产服务。

## API 契约

全部为本机同源 `POST` JSON；支持 `Accept: application/x-ndjson` 进度流。

| 接口 | 输入 | 前置条件/结果 |
| --- | --- | --- |
| `/api/product/review` | `{selection}` 或 `{review,resolutions}` | 签名的通过/矛盾报告；取舍只能来自当前签名报告 |
| `/api/product/brief` | `{review}` | 仅接受通过逻辑检查的签名报告；返回签名的完整简介 |
| `/api/product/preview` | `{brief}` | 并行四张预览；返回签名的预览集合 `{id, briefId, viewIds, digest, images[4]}` |
| `/api/product/revise` | `{brief,dialogue?,input}` | 必要时返回带选项的澄清问题；足够明确时返回修改后的完整选择 |
| `/api/product/confirm` | `{brief,preview,confirmed:true}` | `preview` 只传预览集合的签名引用；返回版本绑定的确认凭据 |
| `/api/product/cad` | `{brief,confirmation,images}` | 同版本确认 + 四张预览 data URL（每张 ≤8MB）；返回签名的 CAD 结果（脚本、网格摘要、四张 SVG） |
| `/api/product/materials` | `{brief,confirmation,figureIds?}` | `figureIds` 只能取登记表中的 id（默认四个 CAD 视角）；返回签名文案 |
| `/api/product/figure` | `{brief,confirmation,templateId}` | 兜底：只接受已启用模板与同版本确认；返回实际黑白结构图 |

简介、预览、确认、CAD、文案、附图都绑定简介版本。改动名称/选择后旧结果不能混用；服务端拒绝伪造的通过状态、被修改的简介、被改动的预览集合和跨版本确认。

## 重试、恢复与存储

- 每个预览视角只发一次上游生成请求；网络失败、超时或权限错误不会自动重复调用生图。四个视角并行，某视角失败只重试该视角。
- CAD 阶段：视觉模型最多两次请求（初始 + 一次校验修正）；FreeCAD 失败不会自动重跑，由用户重试或改用兜底图。
- 同一服务进程内对相同简介版本去重，拒绝同时重复生成，成功结果有有界缓存。重启后内存缓存失效。
- 文案、CAD 结果和兜底黑白图分别落库。一项失败时保留其余，重试仅补齐缺失阶段。
- 产品结果、四张预览与 SVG 附图保存在 IndexedDB，不依赖可能过期的外部图片地址。
- 保存上一版完整成果供放弃修改时恢复，不保留无限图片历史。恢复不重新调用模型。
- 用户离开页面或停止等待时取消请求，并阻止迟到结果覆盖当前项目。FreeCAD 子进程随请求取消被终止。
- 客户端等待：文本/生图阶段 660 秒，CAD 阶段 900 秒；均长于服务端预算（文本 600 秒、FreeCAD 默认 300 秒）。

## 图片、脚本与文档安全边界

- 生图凭据独立于文本凭据，仅服务器向配置的 HTTPS 地址发送；忽略浏览器提交的 key、model、baseUrl 等额外字段。
- 视觉模型输出的脚本视为不可信代码：静态白名单（只允许 `FreeCAD`/`Part`/`math`，禁止 os/sys/subprocess/socket/open/exec/eval/getattr/FreeCADGui/文档操作/双下划线）+ 运行时受限 builtins 和受控 `__import__` + 独立临时目录（`FREECAD_USER_HOME` 也指向该目录）+ 超时后整棵进程树强杀 + 用后删除目录。
- 浏览器上传给视觉模型的只是压缩后的参考图；附图来自服务端执行脚本得到的网格，与简介版本签名绑定，前端导出前核对每张 SVG 的摘要。
- 不把原始上游错误正文返回前端；FreeCAD 失败只返回截断的异常类型与信息。
- Word 中的附图把 SVG 在浏览器栅格化后转为纯黑白 PNG，无远程引用。
- AI 逻辑检查不等于工程验证；自动建模的尺寸是推定值，附图可能与真实产品有差异，必须人工核对。所有文案都是待专业审核的初稿。

## 添加其余黑白模板

兜底黑白图仍从 `PATENT_FIGURE_TEMPLATES` 读取；收到新模板后添加独立 `id`、标题和模板正文，并同步加入 `FIGURE_CATALOG`。不要复用结构图提示词假装是另一种视图。

## 验证

```sh
npm run build
npm run test:product
```

专项测试使用明确标注的测试图片、固定长方体网格和模拟模型返回，不消耗真实模型额度，覆盖：全部选择传递、逻辑阻断、明确去矛盾、签名与版本门禁、四视角并行与单视角补齐、不限轮重画、取消/恢复、CAD 失败兜底、部分失败补齐、并发去重、密钥隔离、URL 安全、脚本白名单、网格投影隐藏线、真实 `.docx` 压缩包中的四张附图与建模记录、黑白像素、移动端与无障碍。`tests/product-workflow-cad.spec.ts` 在检测到本机 FreeCAD 时会真实执行一次建模、一次脚本失败和一次超时强杀；没有 FreeCAD 时跳过该用例。

真实付费测试需手动设置 `RUN_PRODUCT_LIVE=1` 后运行 `npm run test:product:live`。它会保存四张预览、四张 SVG 附图和各阶段结果到 `artifacts/product-workflow-2026-10-09/`，重新运行只补齐缺失阶段。
