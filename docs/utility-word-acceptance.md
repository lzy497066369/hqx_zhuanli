# 实用新型专利 Word 排版验收记录

验收日期：2026-09-25

## 1. 参考文档

本次排版唯一格式参考为：

`/Users/brucelee/Documents/2-撰写资料/1.国家高新技术企业/2025/绍兴市上虞嘉鑫家具有限公司-2025/知识产权/绍兴市上虞嘉鑫家具有限公司/文案/藤编座椅(1).doc`

参考文件 SHA-256：

`034d2033ef0742c5e9fb0c4750a41629f85e703a2c5877263f618525d845376c`

参考文件转为 DOCX 后读取到的版式参数：A4 纵向，页面 11906 × 16838 twip；上、下、左、右边距分别为 1417、850、1418、851 twip；装订线为 0；页眉距离 850 twip；页脚距离 454 twip；文档网格为只指定行，行间距 312 twip（约 15.6pt），字符间距 0。

## 2. 修改范围

本次只修改 Word 导出和验收相关文件：

- `src/features/utility/wordFormat.ts`：集中定义页面、正文、标题、章节页眉页脚、文档网格、自动页码和等比图片布局规则，并在最终 OOXML 中补齐显式 `charSpace=0`。
- `src/features/utility/wordExport.tsx`：复用格式模块生成五个正式分节；通过导出前正式文档清洗 DTO 输出项目内容、权利要求文本、说明书文本和 SVG 图形数据，不改写输入对象。插图保留完整画布并以三倍分辨率导出；“部件及设置理由、连接关系、运动关系”等独立引导行与后段保持同页。
- `src/features/utility/finalDocumentSanitizer.ts`：按字段和语义片段过滤 AI 内部备注、证据引用、验证信息和草稿标记；保留原始材料的实用新型内容、具体实施方式、附图说明及用户补充段落，仅移除精确匹配的生成器占位行和可分离备注。保留合法型号、英文技术术语及作为技术描述的“待核对”状态；对已识别但无法安全分离的混合内容按字段拒绝导出。材料字段仅剩备注时沿用模型内容组装回退，不修改生成器。
- `src/features/utility/drawingModel.ts`：新增共享 `PATENT_FIGURES` 图号注册表，统一图号、图名、来源 ID 和附图说明的数据来源。
- `src/features/utility/UtilityFigure.tsx`：为 SVG 写入统一图形元数据，并移除与 Word 图号重复的局部图号文本，避免图号冲突。
- `tests/utility-workspace.spec.ts`：将 Word 格式契约中的字体和文档网格断言调整为参考文档实测值，内容断言核对原始申请材料。
- `tests/utility-word-layout.spec.ts`：增加图片边界、普通/长/短/含内部备注/补充正文五种真实导出、DOCX XML 契约、页码字段、输入不变和图片比例验收。
- `tests/utility-final-document.spec.ts`：覆盖内部信息清洗、合法术语保留、原文及补充段落完整性、图号一致性和含糊内容拒绝导出。
- `tests/fixtures/auditUtilityWord.py`：审计实际 PDF 页数、连续页码、版心边界、孤立标题、图片比例和图号位置，并对照 DOCX 正文检查渲染文字完整性；输出页面 PNG 哈希分组以核对重复页面。
- `docs/utility-word-standard.md`：记录参考文档和当前 Word 导出标准。
- `docs/utility-word-acceptance.md`：本验收记录。

未修改 Patent Structure Model、AI 生成逻辑、权利要求/说明书/摘要/附图生成逻辑、部件编号逻辑或现有业务流程。旧模板 `public/templates/utility-standard.docx` 未参与导出，也未修改。

## 3. 格式验收

- A4 纵向页面及固定边距：通过。
- 正文 SimSun、14pt、黑色、字符缩放 100%、字符间距 0：通过。
- 正文左对齐、正式首行缩进 2 字符：通过；使用 `firstLineChars=200`，未使用 Tab 模拟缩进。当前实现以参考文档实际段落属性为准。
- 正文行距：通过；每个分节写入 `docGrid type="lines" linePitch="312" charSpace="0"`，没有写入单倍、1.5 倍或多倍正文行距。
- 专利名称：通过；Title 样式为 SimSun、18pt、加粗、居中、零缩进。
- 章节标题：通过；自定义 `PatentSectionHeading` 为 SimSun、14pt、加粗、左对齐、零缩进，并保持标题与后续正文同页。
- 五个正式页眉：通过；分别为“说明书摘要、摘要附图、权利要求书、说明书、说明书附图”，使用 Header、16pt 居中和段落下边框。
- 正式页脚：通过；使用 Footer、段落上边框、居中 PAGE Field 和阿拉伯数字格式。
- 摘要、摘要附图、权利要求书、说明书、说明书附图：通过；五个分节按要求顺序分页。
- 权利要求编号：通过；保留内容中的 `1.`、`2.` 等文本，DOCX 不包含自动编号属性。
- 图片：通过；保留完整 `794 × 1123` 原始画布，以三倍分辨率输出 `2382 × 3369` PNG，按版心和图号空间保持原始宽高比、居中并限制在版心内，图号居中放在图片下方。
- 正文分页：通过；正文由 Word 自动分页，章节边界使用正式分节，未使用空行撑页或正文分页符。
- 正式内容边界：通过；测试材料中以内部备注或标签形式出现的 `AI分析`、`AI备注`、`Evidence`、`validation`、`internal`、`draft`、`待核对` 等内容被清除，周围正式技术内容保留。合法 `E01/E03` 型号、`validation` 模式和显示屏的“待核对”状态不被误删。该检查覆盖已知备注形态，不宣称能够识别任意自然语言内部推理。
- 图号一致性：通过；附图说明、SVG 元数据、Word 图片替代文本和图号段落均来自同一份 `PATENT_FIGURES` 注册表。

## 4. 实际文档检查

使用浏览器真实调用导出入口生成普通、长内容、短内容、含内部备注和补充正文的五份 DOCX，并通过 LibreOffice 兼容渲染器转为 PDF/PNG 检查。以下路径均相对于项目目录：

| 文件 | 页面数 | 分节页码范围 |
| --- | ---: | --- |
| `artifacts/word-qa/round2/normal.docx` | 8 | 摘要 1；摘要附图 2；权利要求书 3；说明书 4-5；说明书附图 6-8 |
| `artifacts/word-qa/round2/short.docx` | 8 | 摘要 1；摘要附图 2；权利要求书 3；说明书 4-5；说明书附图 6-8 |
| `artifacts/word-qa/round2/long.docx` | 16 | 摘要 1-2；摘要附图 3；权利要求书 4-7；说明书 8-13；说明书附图 14-16 |
| `artifacts/word-qa/round2/annotated.docx` | 8 | 摘要 1；摘要附图 2；权利要求书 3；说明书 4-5；说明书附图 6-8 |
| `artifacts/word-qa/round2/extended.docx` | 8 | 摘要 1；摘要附图 2；权利要求书 3；说明书 4-5；说明书附图 6-8 |

五份文件均通过 ZIP 完整性检查和 DOCX XML 检查。渲染后的 48 页全部通过逐页自动审计；其中 30 张不同的页面 PNG 已按原始渲染分辨率逐页查看，其余页面通过 SHA-256 确认与已检查页面完全一致。未发现空白页、标题孤立、页眉页脚覆盖正文、图片溢出、图片变形或图号脱离图片。高纵横比、无图号和横向极宽图片的尺寸边界测试也通过，图片均保持比例并落在页面可用区域内。

正文文字抽取结果与 DOCX 中的正式文本 runs 一致（忽略渲染器产生的空白差异）；五种导出前后的项目数据、附图和材料对象均保持不变。含内部备注的最终文档不含测试注入的内部标签。补充正文样本中的排水槽、装配和运动描述等原始技术段落完整保留，合法型号和英文技术术语仍保留。

## 5. 自动化验证

- Playwright 全量测试：179 passed（34.9 秒）；使用独立测试输出目录完成最终运行。
- 正式文档清洗测试：7 passed；Word 布局集成验收：2 passed，覆盖五种真实浏览器导出，均包含在上述全量测试中。
- `npm run lint`：通过。
- `npm run build`：通过；仅保留 Vite 对较大 JavaScript chunk 的提示，没有构建错误。
- 五份 DOCX：均可由兼容渲染器正常打开并生成 PDF/PNG；XML 审计确认五个分节、`docGrid` 的 `lines/312/0`、左对齐、无自动编号、Footer 中有 `PAGE` 字段，五份文档均嵌入一张无局部框的摘要附图、三张说明书附图和四个图片实例。
- 页码：XML 中为 PAGE 字段，页脚居中，五个分节连续显示；没有手写固定页码。

最终全量测试命令：

```bash
QA_WORD_DIR=/tmp/utility-word-qa/final npm test -- --output=/tmp/utility-word-qa/test-results-final --reporter=line
```

渲染审计命令（Python 环境需包含 `pdfplumber` 和 `lxml`）：

```bash
python3 tests/fixtures/auditUtilityWord.py /tmp/utility-word-qa/final /tmp/utility-word-qa/final-render-v2
```

## 6. 交付文件

- `artifacts/word-qa/round2/normal.docx`：普通样本，8 页。
- `artifacts/word-qa/round2/long.docx`：加长内容样本，16 页。
- `artifacts/word-qa/round2/short.docx`：缩短内容样本，8 页。
- `artifacts/word-qa/round2/annotated.docx`：内部备注清洗样本，8 页。
- `artifacts/word-qa/round2/extended.docx`：补充正文与合法术语保留样本，8 页。
- 同目录保留上述五份文件对应的 PDF 预览；DOCX 与最终测试生成文件进行 SHA-256 一致性核验。

页面视觉检查使用 LibreOffice 兼容渲染器，未在 Microsoft Word 中验证。当前 macOS 环境没有 Microsoft SimSun 字体，因此渲染检查通过 Fontconfig 将 SimSun/宋体回退到 Songti SC；DOCX 内仍保留 `SimSun` 字体声明。Microsoft Word 安装 SimSun 后的实际字形和分页可能因字体度量略有差异，但页面设置、段落属性、文档网格、Header/Footer、PAGE 字段和图片尺寸均已写入 DOCX，并通过 XML 和渲染结果核验。
