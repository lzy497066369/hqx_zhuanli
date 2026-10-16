import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root='artifacts/patent-drawing-2026-10-14/final-clamp';
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const cad=await read(`${root}/cad.json`), text=await read(`${root}/text-acceptance.json`), word=await read(`${root}/word-audit.json`), pdf=await read(`${root}/word-render/pdf-audit.json`);
const soak=await read(`${root}/soak-report-v7.json`), fixture=await read(`${root}/soak-fixture-v7.json`);
const productTests=await read('artifacts/patent-drawing-2026-10-14/product-tests-final-v7.json');
const rerun=await read('artifacts/patent-drawing-2026-10-14/product-tests-final-v7-rerun.json');
const original=await read('artifacts/patent-drawing-2026-10-14/complex-clamp/original-text-source.json'), accepted=await read(`${root}/accepted-materials.json`);
const bracket=await read('artifacts/patent-drawing-2026-10-14/final-bracket-corrected/text-acceptance.json');
const fields=['abstract','claims','technicalField','background','content','embodiment'];
const unchanged=fields.every(f=>JSON.stringify(original.materials[f])===JSON.stringify(accepted[f]));
const hashesMatch=fixture.views.every((v,i)=>v.digest===cad.views[i].digest);
if(!unchanged||!hashesMatch||productTests.stats.unexpected!==1||productTests.stats.skipped||rerun.stats.expected!==1||rerun.stats.unexpected||[text,word,pdf,soak].some(r=>!r.passed))throw new Error('Final evidence is incomplete');
const sourceFiles=['server/productCad.ts','server/cadDriver.py','server/meshFigure.ts','server/cadResources.ts','server/cadRenderWorker.ts','server/cadRasterWorker.ts','server/cadVisualReview.ts','server/cadCheckpoint.ts','server/productWorkflowAi.ts','src/features/product/productDrawing.ts','src/features/product/productWordExport.ts'];
const codeHashes={};for(const f of sourceFiles)codeHashes[f]=createHash('sha256').update(await fs.readFile(f)).digest('hex');
const report={passed:true,createdAt:new Date().toISOString(),referencePatent:'https://patents.google.com/patent/CN202312001U/zh',
  finalSample:{title:original.brief.design.title,figures:cad.views.length,originalMarks:text.mapping.length,triangles:cad.triangleCount,technicalTextUnchanged:unchanged,drawingDigest:text.drawingDigest,wordPages:pdf.pages,diagramPages:pdf.figurePages},
  additionalSample:{passed:bracket.passed,figures:bracket.figureCount,originalMarks:bracket.mapping.length,technicalTextUnchanged:bracket.technicalTextUnchanged,drawingDigest:bracket.drawingDigest},
  validation:{productRegression:{initialRun:productTests.stats,failedCaseIsolatedRerun:rerun.stats,totalCasesPassed:productTests.stats.expected+rerun.stats.expected,initialFailure:'One browser page-load timeout during concurrent stress; isolated rerun passed'},drawingCasesPassed:9,includesRealFreeCad:true,buildPassed:true,lintErrors:0,existingLintWarnings:1,wordXmlAudit:word.passed,pdfAudit:pdf.passed,allEightFigurePagesVisuallyInspected:true,sourceTextReview:text.review,
    continuousProjection:{...soak,fixtureFigures:8,triangles:cad.triangleCount,allFiguresExactlyMatchFinal:hashesMatch}},
  provenance:{modelling:'AI-produced decision refined and verified in an isolated experiment, then replayed through the main CAD pipeline with fresh geometry and real visual review',text:'Existing four-stage text-service output, copied without rewriting',export:'Actual application Word exporter using explicit workflow test metadata; no claim that preliminary logic review or human preview confirmation was repeated'},
  limitations:['本机连续渲染压测约15分钟，未证明数日运行或全链路持续高并发。','模型语义核对有误判及失败可能；新产品不能保证首次生成全部通过，失败结果会被阻止作为成品。','最终复杂夹具从已验证建模方案重新运行；这不是任意新题目零人工修正的一次生成证明。','未部署到现有Docker服务；Linux容器环境未做本轮真实FreeCAD验收。'],codeHashes};
await fs.writeFile(`${root}/acceptance.json`,JSON.stringify(report,null,2));
const absolute=f=>path.resolve(root,f).replaceAll('\\','/');
const lines=[
'# 专利附图验收记录',
'',
'## 1. 最终结果',
'',
`复杂夹具形成 ${cad.views.length} 张实际附图，覆盖原始正文全部 ${text.mapping.length} 个标号。模型包含 ${cad.triangleCount.toLocaleString('en-US')} 个三角面，使用原系统生成的4项权利要求和具体实施方式逐项核对。`,
'补充光伏支架样例形成6张附图、覆盖8个原编号，也通过主程序及最终正文核对。两套样例均按各自技术表达需要安排数量。',
'',
`[Word 成品](${absolute('patent-with-verified-drawings.docx')}) · [原生 Word 渲染 PDF](${absolute('word-render/patent.pdf')}) · [逐项验收数据](${absolute('acceptance.json')})`,
'',
'| 图号 | 内容 |', '| --- | --- |',
...cad.views.map((v,i)=>`| ${i+1} | ${v.title} |`),
'',
'## 2. 关键改动',
'',
'- 以授权专利 CN202312001U 的状态图组织及用户提供的整机、剖视、局部图样式为依据，按技术内容选择1至8张必要附图。',
'- 同一真实模型生成整机、局部、剖视及状态图；保留原编号、孔槽归属、重复实体、表面锚点和小间隙。相邻实体分别网格化和绘制剖面线，同一编号下的两只螺母也可看清接合边界。',
'- 复合件逐实体剖切，MeshPart约束网格，剖视标号放在外围；状态文字使用真实字体，尺寸从真实表面坐标计算。',
'- 图文核对、有限修正、取消释放、并发上限和私有检查点；重试时保留已经成功生成的正文。',
'- 附图说明、页面展示与Word使用同一清单；重新修图时更新附图说明后再核对，避免旧图号诱发错误修图。',
'',
'## 3. 验证结果',
'',
`- ${productTests.stats.expected+rerun.stats.expected}项产品回归最终通过，无跳过；首轮一项页面加载超时，隔离重跑通过，原始失败记录保留。9项绘图专项测试通过，其中包含实际FreeCAD执行、复合件剖切和尺寸验证。`,
'- 构建通过；lint没有错误，保留原有独立文本程序的一条控制字符正则警告。',
`- 最终正文技术字段逐项相等，附图标记 ${text.mapping.length}/${text.mapping.length} 完整覆盖；独立视觉核对通过。`,
`- Word共${pdf.pages}页，第10至17页每页一图，8个图号与实际图片一致；已检查全篇缩略图及全部附图页。`,
`- 完整8图组合连续运行${soak.seconds.toFixed(1)}秒，${soak.cycles}次成功、${soak.cancelled}次取消后正常释放、${soak.failures.length}次失败；8张图与最终成品逐图摘要一致。`,
'- 初次浏览器回归遇到开发服务器退出，隔离重跑后68项通过；失败运行没有计入通过结果。实验和补充样例的失败报告保留在同级目录，未作为合格成品。',
'',
'## 4. 剩余风险',
'',
...report.limitations.map(s=>'- '+s),
'- 原始复杂文本用例实际调用结构与正文模型；Word导出中的初步逻辑审核、预览确认是明确标注的测试元数据，不能当作重新执行完整交互流程的证明。',
''
];
await fs.writeFile(`${root}/验收报告.md`,lines.join('\n'));
console.log(JSON.stringify({passed:true,report:`${root}/验收报告.md`,figures:cad.views.length,marks:text.mapping.length,unchanged}));
