import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

if (!process.argv[2]) throw new Error('Provide the batch evaluation directory.');
const directory = resolve(process.argv[2]);
const m = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
if (!m.finishedAt || (m.retries?.length && !m.retryFinishedAt)) throw new Error('Wait until all attempts finish.');
const notes = JSON.parse(readFileSync(join(directory, 'manual-notes.json'), 'utf8'));
const rows = m.products.flatMap(product => m.runs.filter(r => r.product === product).sort((a, b) => a.repetition - b.repetition));
const final = r => m.retries?.find(t => t.id === r.id) || r;
const complete = rows.filter(r => final(r).status === 'completed');
const firstComplete = rows.filter(r => r.status === 'completed');
const uncertain = complete.filter(r => final(r).uncertainPhrases.length);
const structureFaults = new Set(notes.filter(n => n.confirmed && n.scope === '结构资料一致性').map(n => n.id));
const minutes = seconds => `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
const fileLink = (label, filename) => `[${label}](<${join(directory, filename).replaceAll('\\', '/')}>)`;
let md = `# 专利文本多项目重复生成评估\n\n本轮固定同一提示词和程序快照，测试纸箱、夹具、闸门三个产品，每个相同产品和问题独立生成两次，共${rows.length}份。用户操作由测试脚本代行，未人工挑选更容易成功的问题。\n\n首轮${firstComplete.length}/${rows.length}完成；${m.retries?.length || 0}份失败任务各补一次断点重试后，最终${complete.length}/${rows.length}完成。完成表示现有生成流程结束，不表示技术方案、保护范围或专利性已经验证。\n\n## 实测结论\n\n`;
md += `- 文字组织和措辞总体可用于初稿：完成的${complete.length}份中，${uncertain.length}份命中本轮检查的未完成设计措辞（初拟、暂定、拟采用、待验证、待确认、尚需确定、根据需要确定、需按……核定）。该检查不是对所有问题措辞的穷尽检测。\n`;
md += `- 结构资料一致性仍需修订：逐项查看后，${structureFaults.size}份最终或已保存方案发现复核修改写入错误部件字段。详细证据见下文；若正文自身表达正确，也不能据此忽略结构表的问题。\n`;
md += '- 权利要求取舍有波动：两份夹具中，具体导轨和弹簧形式的主从项布局不同，其中一次上位概括被既有标号名称校验拒绝。不能用主项长度或完成状态替代保护范围分析。\n';
md += '- 本轮结果支持将系统用于生成可供修订的初稿，尚不足以支持无人核对后直接提交。本轮不修改应用原有完成判定、不增加质量门槛，也不修改生成中的样稿。\n\n';
md += '## 固定测试条件\n\n';
md += `- 每类产品只生成一组候选问题，固定选择第一项；每次结构方案独立生成，第二次不复制第一次的结构或正文。\n- 最多两个模型任务并发。沿用现有备用模型及自动修正机制。\n- 失败任务仅补一次断点重试，保留首轮结果和报错；补测不计作新独立样本。\n- 提示词快照 SHA-256：\`${m.hashes['prompts.mjs']}\`。\n- 三个输入问题如下。\n\n`;
for (const product of m.products) {
  const p = m.proposals.find(p => p.product === product);
  md += `- **${product}**：${p?.problems?.[0]?.title || p?.error}。${p?.problems?.[0]?.problem || ''}\n`;
}
md += '\n## 逐份结果\n\n| 产品及次数 | 首轮 | 最终 | 标记数 / 实体或组件数 | 权利要求数 | 独立项字符数 | 正文字符数 | 实际执行耗时 | 初稿评价 |\n|---|---|---|---:|---:|---:|---:|---|---|\n';
for (const r of rows) {
  const f = final(r), retry = f !== r;
  const ownNotes = notes.filter(n => n.id === r.id);
  const verdict = f.status !== 'completed' ? '未获得完整正文' : structureFaults.has(r.id) ? '正文可读，结构资料需修订' : ownNotes.some(n => n.priority === '小幅润色') ? '可作初稿，需小幅润色' : '可作初稿，见具体评语';
  md += `| ${r.product} ${r.repetition} | ${r.status === 'completed' ? '完成' : '中断'} | ${f.status === 'completed' ? retry ? '重试完成' : '完成' : '未完成'} | ${f.parts ?? '-'} / ${f.physicalParts ?? '-'} | ${f.claims ?? '-'} | ${f.claim1Chars ?? '-'} | ${f.totalChars || '-'} | ${minutes(r.elapsedSeconds + (retry ? f.elapsedSeconds : 0))} | ${verdict} |\n`;
}
md += '\n字符数按文本字符串计，包含标点和标号；长短本身不是质量评级。实体或组件数按模型的类型标注统计，不等于制造BOM数量。执行耗时累计首轮与重试的实际运行时间，不包含两次尝试之间等待补测的间隔。\n\n';
md += '## 具体发现与原稿\n\n';
for (const r of rows) {
  const f = final(r), suffix = f === r ? '' : '-retry';
  md += `### ${r.product} 第${r.repetition}次\n\n${f.title || '未生成完整标题'}。${fileLink('完整结构与生成记录', `${r.product}-${r.repetition}${suffix}.json`)}`;
  if (f.status === 'completed') md += `；${fileLink('专利正文', `${r.product}-${r.repetition}${suffix}.txt`)}；[在应用中查看](http://127.0.0.1:3210/?job=${r.id})`;
  md += '。\n\n';
  for (const note of notes.filter(n => n.id === r.id)) md += `- **${note.scope}**：${note.finding} 定位：${note.evidence.map(e => `\`${e}\``).join('、')}。\n`;
  if (r.error) md += `- 首轮中断：${r.error} 本轮${f === r ? '没有重试结果' : `补测状态为${f.status}`}。\n`;
  md += `- 首轮自动内容修正${r.automaticRepairs?.length || 0}次${f === r ? '' : `，补测自动内容修正${f.automaticRepairs?.length || 0}次`}；这些次数与网络故障切换分开记录。\n\n`;
}
md += '## 使用这些结果时的范围\n\n这是一轮六份样稿的小样本实测，覆盖三个产品类别及重复生成，不代表全产品覆盖率或授权概率。没有执行现有技术检索、附图核对、几何仿真、强度计算或样件试验。人工比较着重结构与正文的一致性、权利要求层次、正文组织和未完成设计措辞。原始运行清单与两轮记录均保存在本目录，未删除失败样本。\n';
const report = join(directory, '批量生成评估.md');
writeFileSync(report, md, 'utf8');
console.log(JSON.stringify({ report, firstComplete: firstComplete.length, finalComplete: complete.length, total: rows.length, uncertain: uncertain.length, structureFaults: structureFaults.size }));
