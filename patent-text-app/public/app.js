const $ = id => document.getElementById(id);
let proposal, selected, currentJob, jobId, pollTimer, stages = [], renderingKey = '', pending = false;
const statusNames = { running: '生成中', completed: '已完成', needs_review: '有待复核项', failed: '生成失败', cancelled: '已停止' };

function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}
function message(value, error = false) { $('message').textContent = value; $('message').className = error ? 'error' : ''; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败，请重试。');
  return value;
}
function setBusy(value) {
  $('propose').disabled = value;
  $('product').disabled = value;
  $('generate').disabled = value || !selected;
}

$('product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const product = $('product').value.trim();
  if (!product) return;
  setBusy(true); selected = undefined; pending = true;
  $('choices').hidden = true;
  const started = Date.now();
  const timer = setInterval(() => message(`正在分析产品并生成候选问题… ${Math.floor((Date.now() - started) / 1000)}秒`), 1000);
  message('正在分析产品并生成候选问题…');
  try {
    proposal = await api('/api/problems', { method: 'POST', body: JSON.stringify({ product }) });
    clearInterval(timer);
    $('scenario').textContent = `默认场景：${proposal.scenario}`;
    $('problem-list').replaceChildren();
    for (const problem of proposal.problems) {
      const label = node('label', undefined, 'problem');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'problem'; input.value = problem.id;
      input.addEventListener('change', () => { selected = problem.id; $('generate').disabled = false; });
      label.append(input, node('strong', problem.title), node('p', problem.problem), node('small', `目标：${problem.goal}`), node('small', `候选方向：${problem.approach}`));
      $('problem-list').append(label);
    }
    $('choices').hidden = false;
    message('请选择一个问题，系统将继续完成结构设计和文本生成。');
  } catch (error) { clearInterval(timer); message(error.message, true); }
  finally { clearInterval(timer); pending = false; setBusy(false); }
});

$('generate').addEventListener('click', async () => {
  if (!proposal || !selected) return;
  setBusy(true); pending = true;
  try {
    const result = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ proposalId: proposal.id, problemId: selected }) });
    $('choices').hidden = true;
    message('生成已开始，完成后可复制或下载文本。');
    openJob(result.id);
  } catch (error) { message(error.message, true); setBusy(false); }
  finally { pending = false; }
});

function table(headers, rows) {
  const wrap = node('div', undefined, 'table-wrap'), t = node('table'), head = node('thead'), body = node('tbody'), tr = node('tr');
  for (const title of headers) tr.append(node('th', title));
  head.append(tr);
  for (const row of rows) { const r = node('tr'); for (const cell of row) r.append(node('td', cell)); body.append(r); }
  t.append(head, body); wrap.append(t); return wrap;
}
function list(items, ordered = false) {
  const result = node(ordered ? 'ol' : 'ul');
  for (const item of items || []) result.append(node('li', item));
  return result;
}
function renderPlan(plan) {
  const target = $('panel-plan'); target.replaceChildren();
  const name = id => `${id} ${plan.parts.find(p => p.id === id)?.name || ''}`;
  const kinds = { part: '独立零件', assembly: '组件', region: '局部部位', opening: '孔槽', surface: '配合面' };
  target.append(node('p', plan.scenario), node('p', `技术问题：${plan.problem}`), node('p', `设计目标：${plan.goal}`));
  if (plan.focus) target.append(node('h3', '核心改进'), node('p', plan.focus.improvement));
  target.append(node('h3', '部件及结构特征表'));
  if (plan.schemaVersion === 2) target.append(table(['编号 / 名称', '类型 / 所属', '作用', '位置', '运动状态'], plan.parts.map(p => [name(p.id), `${kinds[p.kind] || p.kind}\n${p.parentId ? `属于 ${name(p.parentId)}` : '顶层结构'}`, `${p.importance === 'core' ? '核心' : '配套'}：${p.role}`, p.position, p.motion])));
  else target.append(table(['编号', '名称', '作用', '位置', '运动状态'], plan.parts.map(p => [p.id, p.name, p.role, p.position, p.motion])));
  target.append(node('h3', '连接与配合关系'), table(['关联结构', '关系', '具体结构'], plan.connections.map(c => [`${name(c.from)} ↔ ${name(c.to)}`, c.type, c.detail])));
  if (plan.coreActions?.length) {
    target.append(node('h3', '核心动作及实现依据'));
    for (const action of plan.coreActions) {
      target.append(node('h4', action.name), node('p', `涉及结构：${action.partIds.map(name).join('、')}`));
      target.append(table(['项目', '具体关系'], [
        ['触发条件', action.trigger], ['初始状态', action.before], ['位置与约束', action.constraint],
        ['动作过程', action.sequence.map((s, i) => `${i + 1}. ${s}`).join('\n')], ['结束状态', action.after],
        ['避让或通路', action.clearance], ['结构依据', action.basis],
      ]));
    }
  }
  target.append(node('h3', '工作过程'), list(plan.workingSteps.map(s => s.step), true));
  target.append(node('h3', '结构与效果'), table(['相关零件', '作用机制', '直接效果'], plan.improvements.map(i => [i.partIds.map(name).join('、'), i.mechanism, i.effect])));
}
function renderScope(plan) {
  const target = $('panel-scope'); target.replaceChildren();
  if (!plan.claimPlan) { target.append(node('p', '这份历史结果未单独保存保护方案。新生成的任务会列出特征取舍依据。', 'muted')); return; }
  target.append(node('p', `核心保护组合：${plan.claimPlan.focus}`));
  const name = id => `${id} ${plan.parts.find(p => p.id === id)?.name || ''}`;
  for (const [key, label] of [['independent', '独立权利要求的必要特征'], ['dependent', '从属权利要求的进一步限定'], ['embodimentOnly', '仅在实施例交代的细节']]) {
    target.append(node('h3', label));
    const items = plan.claimPlan[key] || [];
    target.append(items.length ? table(['技术特征', '关联结构', '取舍理由'], items.map(item => [item.feature, item.partIds.map(name).join('、'), item.reason])) : node('p', '本方案未单独列出此类特征。', 'muted'));
  }
}
function renderNotes(plan) {
  const target = $('panel-notes'); target.replaceChildren();
  target.append(node('p', '设计选择及工程验证事项独立保存，下载专利正文时不包含这些记录。', 'muted'));
  if (plan.focus?.boundary) target.append(node('h3', '本方案的范围'), node('p', plan.focus.boundary));
  target.append(node('h3', '本方案采用的设计选择'), list(plan.assumptions), node('h3', '后续工程验证事项'), list(plan.verificationNeeds));
  if (plan.schemaVersion === 2) target.append(node('h3', '结构保留理由'), table(['结构', '必要性'], plan.parts.map(p => [`${p.id} ${p.name}`, p.necessity])));
}
function renderReview(job) {
  const target = $('panel-review'); target.replaceChildren();
  for (const [label, review] of [['结构检查', job.structureReview], ['文本检查', job.textReview]]) {
    target.append(node('h3', label));
    if (!review) { target.append(node('p', '尚未完成。', 'muted')); continue; }
    if (!review.findings.length) target.append(node('p', '本轮模型检查未列出具体修改项。', 'muted'));
    for (const item of review.findings) {
      const div = node('div', undefined, 'review-item');
      div.append(node('strong', item.location), node('p', `问题：${item.issue}`), node('p', `处理：${item.resolution}`));
      target.append(div);
    }
    if (review.unresolved.length) target.append(node('p', '仍需处理', 'error'), list(review.unresolved));
  }
  target.append(node('p', '以上为结构和文字审查记录，不是专利检索、工程试验或授权结论。', 'muted'));
}
function renderJob(job) {
  currentJob = job;
  $('job-section').hidden = false;
  $('job-title').textContent = statusNames[job.status] || job.status;
  $('job-context').textContent = `${job.product} · ${job.problem.title}`;
  $('cancel').hidden = job.status !== 'running';
  $('retry').hidden = !['failed', 'cancelled', 'needs_review'].includes(job.status);
  $('job-error').hidden = !job.error;
  $('job-error').textContent = job.error || '';
  if (!pending) setBusy(job.status === 'running');
  const current = stages.findIndex(s => s.id === job.stage);
  const complete = { structure: !!job.initialPlan, structureReview: !!job.structureReview, draft: !!job.draft, textReview: !!job.textReview };
  $('stages').replaceChildren(...stages.map((s, i) => node('li', `${complete[s.id] ? '✓' : i + 1} ${s.label}`, complete[s.id] ? 'done' : i === current && job.status === 'running' ? 'active' : '')));
  const seconds = Math.floor((Date.now() - Date.parse(job.createdAt)) / 1000);
  $('activity').textContent = job.status === 'running' ? `当前阶段已接收 ${job.progressChars || 0} 字符 · 本任务已用 ${Math.floor(seconds / 60)}分${seconds % 60}秒。可以离开页面，后台会继续生成。` : job.status === 'completed' ? '草稿已保存，可查看零件、结构关系及修正记录。' : job.status === 'needs_review' ? '请查看检查记录中的未解决问题，也可重试文本检查。' : '已完成的阶段已保存，重试会继续生成。';
  $('event-list').replaceChildren(...job.events.map(e => node('p', `${new Date(e.time).toLocaleTimeString('zh-CN')}  ${e.message}`)));
  const plan = job.plan || job.initialPlan;
  $('results').hidden = !plan;
  $('copy').disabled = !job.document;
  $('download-text').hidden = !job.document;
  $('download-text').href = `/api/jobs/${job.id}/download`;
  $('download-json').href = `/api/jobs/${job.id}/download?format=json`;
  const key = `${job.id}:${!!job.initialPlan}:${!!job.structureReview}:${!!job.draft}:${!!job.textReview}:${job.status}`;
  if (plan && key !== renderingKey) {
    renderingKey = key;
    renderPlan(plan); renderScope(plan); renderNotes(plan); renderReview(job);
    $('document').textContent = job.text || '结构方案已生成，正在继续生成与检查专利正文。可先查看“部件与结构”。';
  }
}
async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const job = await api(`/api/jobs/${id}`);
    if (id !== jobId) return;
    renderJob(job);
    if (job.status === 'running') pollTimer = setTimeout(() => poll(id), 2000);
    else loadHistory();
  } catch (error) {
    message(`读取进度失败：${error.message} 正在重新连接。`, true);
    if (id === jobId) pollTimer = setTimeout(() => poll(id), 4000);
  }
}
function openJob(id) {
  jobId = id; renderingKey = '';
  localStorage.setItem('patent-text-last-job', id);
  $('choices').hidden = true;
  poll(id);
}
for (const action of ['cancel', 'retry']) $(action).addEventListener('click', async () => {
  if (!jobId) return;
  $(action).disabled = true;
  try { await api(`/api/jobs/${jobId}/${action}`, { method: 'POST', body: '{}' }); await poll(jobId); }
  catch (error) { message(error.message, true); }
  finally { $(action).disabled = false; }
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab === button;
    tab.setAttribute('aria-selected', String(active));
    $(`panel-${tab.dataset.tab}`).hidden = !active;
  }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(currentJob.text); $('copy').textContent = '已复制'; setTimeout(() => { $('copy').textContent = '复制正文'; }, 1600); }
  catch { message('复制失败，请下载文本或选中正文复制。', true); }
});
async function loadHistory() {
  try {
    const { jobs } = await api('/api/jobs');
    $('history-section').hidden = !jobs.length;
    $('history').replaceChildren(new Option('选择已生成的任务', ''), ...jobs.map(j => new Option(`${j.title} · ${statusNames[j.status]} · ${new Date(j.updatedAt).toLocaleString('zh-CN')}`, j.id)));
    $('history').value = jobId || '';
  } catch { /* Current results remain usable when history refresh fails. */ }
}
$('history').addEventListener('change', () => { if ($('history').value) openJob($('history').value); });
try {
  const status = await api('/api/status'); stages = status.stages;
  $('connection').textContent = status.configured ? '文本接口已就绪' : '文本接口未配置';
  if (!status.configured) message('请在应用或上级目录的 .env.local 中配置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL，然后重启服务。', true);
  await loadHistory();
  const last = new URLSearchParams(location.search).get('job') || localStorage.getItem('patent-text-last-job');
  if (last) {
    try { const job = await api(`/api/jobs/${last}`); openJob(job.id); }
    catch { localStorage.removeItem('patent-text-last-job'); }
  }
} catch { $('connection').textContent = '服务未连接'; message('无法连接本地服务，请确认启动窗口仍在运行。', true); }
