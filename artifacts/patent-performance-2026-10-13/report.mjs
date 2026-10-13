import fs from 'node:fs/promises';
const root = 'artifacts/patent-performance-2026-10-13';
const read = name => fs.readFile(`${root}/${name}.json`, 'utf8').then(JSON.parse);
const base = await read('timings');
const experiment = await read('experiments');
const naming = await read('naming-fixed');
const currentPreview = await read('preview-current-timings');
const seconds = n => (n / 1000).toFixed(1);
const stage = name => base.stages.find(s => s.name === name);
const request = name => base.requests.find(r => r.stage === name);
const concise = experiment.stages.find(s => s.name === 'brief-concise-prompt');
const conciseRequest = experiment.requests.find(s => s.stage === 'brief-concise-prompt');
const names = { review: '逻辑审查', brief: '详细产品简介', preview: '预览（测试启动时的四图并行版本）', confirm: '预览确认接口', 'browser-image-compression': '浏览器图片压缩', cad: 'CAD 全阶段', materials: '申请文案', 'word-export': 'Word 导出' };
const total = base.stages.reduce((sum,s) => sum + s.elapsedMs, 0);
const lines = [
  '# 专利生成真实耗时诊断 · 2026-10-13', '',
  `结论：本次完整生成成功，启动时版本从逻辑审查到 Word 导出共 ${seconds(total)} 秒，最慢的是详细简介（${seconds(stage('brief').elapsedMs)} 秒），其次是文案（${seconds(stage('materials').elapsedMs)} 秒）。CAD 本机部分很快，主要等待视觉模型。`, '',
  '使用合成测试产品「一种具有滑槽锁紧连接结构的光伏组件安装支架」，文本/视觉模型为 gpt-6.1-sol，图片为 gpt-image-2.5，FreeCAD 1.1.4。实际调用生产服务函数、真实付费上游、真实 FreeCAD、真实浏览器图片压缩和 Word 导出。未包含人手选择/确认时间、HTTP 调度排队、账号认证或项目数据库开销。前置命名阶段另行补测，不能将各独立运行的数值称为同一轮端到端时长。', '',
  '## 分步实测', '', '| 步骤 | 秒 | 结果 |', '|---|---:|---|',
  ...base.stages.map(s => `| ${names[s.name]} | ${seconds(s.elapsedMs)} | ${s.outcome} |`), '',
  '完整链路调用 4 次文本/视觉请求及 4 次生图请求；没有格式修正、模型切换、超时或失败。最终产出四张彩色预览、四张 SVG 专利附图和 sample-patent.docx。CAD 网格为 13,328 个顶点、26,512 个三角面。', '',
  '## 模型和服务商端', '', '| 步骤 | 首段内容前等待 | 首段至末段输出 | 输出字符 | 最大流间隔 |', '|---|---:|---:|---:|---:|',
  ...['review','brief','cad','materials'].map(name => { const r=request(name); return `| ${names[name]} | ${seconds(r.firstContentMs)} 秒 | ${seconds(r.lastContentMs-r.firstContentMs)} 秒 | ${r.contentChars} | ${seconds(r.maxContentGapMs)} 秒 |`; }), '',
  '简介和文案大部分时间用于输出长文本，平均约 44–46 个字符/秒。CAD 请求在收到首段内容前等了约 62 秒，后续输出约 36 秒。本次没有模型错误或修正；不能据此断言模型不合格。首段前等待包含代理/服务商排队、输入处理、模型推理等，当前日志无法进一步分开。', '',
  '## 提示词对照', '',
  `同一个 gpt-6.1-sol、相同 selection 与 logicalAssumptions、相同 14,000 token 上限，增加字段篇幅目标并要求合并重复内容：简介 ${seconds(stage('brief').elapsedMs)} → ${seconds(concise.elapsedMs)} 秒，下降 ${(100*(1-concise.elapsedMs/stage('brief').elapsedMs)).toFixed(1)}%；输出 ${request('brief').contentChars} → ${conciseRequest.outputChars} 字符。`, '',
  '对照通过 isProductDesign，覆盖全部四个 choice id，保留 T 形滑槽调位、独立锁紧、压板紧固及防脱挡边等输入特征，完整输出推定与核实事项。但生成的推定方案细节/常规部件拆分发生变化；这不是技术等价性证明，也没有用精简简介再跑一轮 CAD 与文案。对照提示词保存在 experiments.mjs，本次未把它替换到生产产品简介提示词。单次对照受服务商负载与采样波动影响，不应承诺固定 40% 加速。', '',
  '建议优先限定 appearance、workingPrinciple、assumptions 等字段的目标篇幅、减少跨字段重复；必要部件、连接和运动信息优先完整。文案可以限制重复解释，独立权利要求的必要技术特征不能为了速度删减。仅降低 max_completion_tokens 会增加截断风险，并不保证模型输出更简洁。', '',
  '## 网络', '',
  `对实际服务商主机三次 HTTPS HEAD 探测：${base.network.map(n=>`${seconds(n.totalMs)} 秒`).join('、')}。首次 DNS 74 毫秒，后续 4–8 毫秒。原四张图片在响应头后下载各约 1.3–1.5 秒；文本流的最大间隔约 0.4–1.6 秒，未见断流或网络重试。`, '',
  '本次证据不支持「本地网络是主要瓶颈」。HEAD 与生成接口的后端路径不同，不能排除服务商内部排队、代理转发或代理限速，也不能用 HEAD 将 62 秒首段等待完全归因于模型。', '',
  '## 代码：已修复的两个误判', '',
  '1. server/namingAi.ts 对候选做无条件配件过滤。用户本身填写「光伏组件安装支架」时，所有支架选题都被丢弃。真实补测首模型在 16.3 秒返回五个选题，第二模型又用 21.2 秒，第三模型等待 72 秒后超时；选题阶段共 109.5 秒后失败。修复为相对于输入产品判断配件，保留光伏板不能改成其安装支架的限制。将修复前同一份首模型响应回放到修复后的代码，五个选题均可接受、只调用一次，证明原失败由过滤代码导致。', '',
  '2. isStructuralFeature 的关键词没有「挡边」，因此「防脱挡边」被当作效果而拒绝，后续结构资料和命名在本地校验就返回 INVALID_INPUT。补充实际结构名「挡边」，「防脱」效果本身仍不被接纳。', '',
  '修复后真实复测：', '', '| 步骤 | 秒 | 结果 |', '|---|---:|---|',
  ...naming.stages.map(s=>`| ${{'naming-product-options':'产品选题','naming-structure-evidence':'结构资料','naming-names':'候选名称'}[s.name]} | ${seconds(s.elapsedMs)} | ${s.outcome} |`), '',
  '31 项命名规则、接口、页面及移动端测试全部通过，四个改动文件 lint 通过。初次浏览器测试因本机缺少 Playwright Chromium 失败，切换已安装的 Edge 后完整重跑通过。', '',
  '## 代码：流程安排的优化空间', '',
  'CAD 之后才生成文案，导致确认后等待 CAD + 文案。本次为约 226 秒。如果先基于已确认简介生成文案主体，在 CAD 成功后再绑定真实图清单并由程序补附图说明，理论上可把这两阶段等待压到约 126 秒（少约 100 秒）。这是计算得到的上限，不是已实现后的实测。实现时需处理 CAD 失败/兜底、附图清单变化、取消、缓存、签名和导出门禁，不能简单 Promise.all 后直接开放导出。', '',
  'CAD 本机 FreeCAD 约 1.0 秒，投影/编号/摘要约 1.1 秒；压缩约 0.7 秒，导出约 1.6 秒。这些部分不应优先做性能改造。CAD 输入重复传 introduction 与 components，文案也如此，可以评估统一结构化输入，但不应损失关键关系。校验修正目前只提供错误清单、未把上一轮输出作为对话上下文回传，属于可能增加重复生成的设计问题，本次没有触发，尚未测得收益。', '',
  '## 测试期间更新的预览链路', '',
  '完整基线进程启动后，工作区由另一项编辑将预览改成「先主体参考图，再并行三张参考视图」。基线进程已经加载原模块，因此保留其 37.7 秒数据作为旧版本测量；单独加载最新代码复测，并记录源码 SHA-256，不能混淆两个版本。', '',
  currentPreview.complete ? `新版参考预览成功，完整耗时 ${seconds(currentPreview.elapsedMs)} 秒。该依赖用于保持视图一致，不能直接恢复四图互不参考并行来追求速度。` : `新版参考预览未完成：${JSON.stringify(currentPreview.error || {running:true})}，耗时 ${seconds(currentPreview.elapsedMs || 0)} 秒。`, '',
  '| 上游请求 | 秒 | HTTP | 参考图字节 |', '|---|---:|---:|---:|',
  ...currentPreview.requests.map(r=>`| ${r.endpoint} #${r.id} | ${seconds(r.totalMs || r.elapsedMs || 0)} | ${r.status || '-'} | ${r.referenceBytes} |`), '',
  '## 文件与复现', '',
  '- timings.json：完整链路计时、每次请求首段/输出/间隔/字节/服务商 usage、阶段进度及网络探测。',
  '- experiments.json：同模型提示词对照及修复前补测失败。',
  '- naming-fixed.json、naming-replay-proof.json：修复后真实补测及原始响应回放证据。',
  '- preview-current-timings.json：新版参考预览计时和源码摘要。',
  '- state.json、sample-patent.docx、cad-*.svg、color-*.png：完整基线成果（合成测试资料）。',
  '- run.mjs、experiments.mjs、preview-current.mjs：复现脚本，读取 .env.local，真实请求会使用服务商额度。', '',
  '此次生产修改仅涉及 namingAi.ts 的相对客体判断、naming.ts 的「挡边」识别及两个回归测试；没有覆盖工作区其他正在进行的产品流程编辑。', '',
];
await fs.writeFile(`${root}/report.md`, lines.join('\n'));
console.log(JSON.stringify({ baselineSeconds: total/1000, conciseSeconds: concise.elapsedMs/1000, namingSeconds: naming.stages.reduce((n,s)=>n+s.elapsedMs,0)/1000, latestPreviewSeconds: currentPreview.elapsedMs/1000, complete: currentPreview.complete }));
