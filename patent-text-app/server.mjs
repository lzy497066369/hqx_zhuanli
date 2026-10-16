import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig } from './config.mjs';
import { generateProblems, runPipeline, formatDocument, STAGES } from './pipeline.mjs';

const TYPES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function createApp(config, { dataDir = join(ROOT, 'data'), problemGenerator = generateProblems, pipeline = runPipeline } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const jobs = new Map(), proposals = new Map(), controllers = new Map();
  let proposing = false;
  function save(job) {
    job.updatedAt = new Date().toISOString();
    const path = join(dataDir, `${job.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  for (const name of readdirSync(dataDir).filter(n => /^[\da-f-]{36}\.json$/.test(n))) {
    try {
      const job = JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
      if (job.status === 'running') { job.status = 'failed'; job.error = '服务重启中断了生成，点击重试可从已完成阶段继续。'; save(job); }
      jobs.set(job.id, job);
    } catch { /* Ignore an unreadable local result without exposing its contents. */ }
  }
  function start(job) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    job.status = 'running'; job.error = ''; save(job);
    function update(message) {
      if (message) job.events.push({ time: new Date().toISOString(), message });
      job.events = job.events.slice(-50);
      save(job);
    }
    Promise.resolve().then(() => pipeline(config, job, controller.signal, update)).catch(error => {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = controller.signal.aborted ? '已停止生成；可以从已完成阶段继续。' : error.message;
      update(job.error);
    }).finally(() => { controllers.delete(job.id); save(job); });
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error('输入内容过长。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求格式不正确。'); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return json(res, 403, { error: '仅允许本机访问。' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: '不接受跨站请求。' });
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && TYPES[path]) {
        const [file, type] = TYPES[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(readFileSync(join(ROOT, 'public', file)));
      }
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, { configured: !!config.providers.length, model: config.providers[0]?.model || '', stages: STAGES });
      if (req.method === 'GET' && path === '/api/jobs') return json(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30).map(j => ({ id: j.id, product: j.product, title: j.plan?.title || j.problem.title, status: j.status, updatedAt: j.updatedAt })) });
      if (req.method === 'POST' && path === '/api/problems') {
        const input = await body(req);
        if (typeof input?.product !== 'string' || !input.product.trim() || input.product.trim().length > 80 || /[\x00-\x1f]/.test(input.product)) return json(res, 400, { error: '请输入1至80字的基本产品名称。' });
        if (proposing || controllers.size) return json(res, 409, { error: '已有任务正在生成，请等待完成或停止当前任务。' });
        proposing = true;
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        try {
          const product = input.product.trim();
          const result = await problemGenerator(config, product, controller.signal);
          const proposal = { id: randomUUID(), product, ...result };
          proposals.set(proposal.id, proposal);
          if (proposals.size > 30) proposals.delete(proposals.keys().next().value);
          return json(res, 200, proposal);
        } catch (error) { return json(res, 502, { error: error.message }); }
        finally { proposing = false; }
      }
      if (req.method === 'POST' && path === '/api/jobs') {
        const input = await body(req);
        const proposal = proposals.get(input?.proposalId);
        const problem = proposal?.problems.find(p => p.id === input?.problemId);
        if (!problem) return json(res, 400, { error: '请选择当前生成的问题；服务重启后请重新获取问题。' });
        if (controllers.size || proposing) return json(res, 409, { error: '已有任务正在生成，请等待完成或停止当前任务。' });
        const job = { id: randomUUID(), product: proposal.product, scenario: proposal.scenario, problem, status: 'running', stage: 'structure', createdAt: new Date().toISOString(), events: [], notes: ['此方案由系统提出，供设计核验和申请撰写参考。', '当前版本未生成附图，也未执行现有技术检索、CAD或性能验证。'] };
        jobs.set(job.id, job); start(job);
        return json(res, 202, { id: job.id });
      }
      const match = path.match(/^\/api\/jobs\/([\da-f-]{36})(?:\/(retry|cancel|download))?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return json(res, 404, { error: '未找到该任务。' });
        if (req.method === 'GET' && !match[2]) return json(res, 200, { ...job, text: job.document ? formatDocument(job.document) : '' });
        if (req.method === 'POST' && match[2] === 'cancel') {
          controllers.get(job.id)?.abort(); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && match[2] === 'retry') {
          if (!['failed', 'cancelled', 'needs_review'].includes(job.status) || controllers.size || proposing) return json(res, 409, { error: '当前不能重试，请等待正在运行的任务结束。' });
          if (job.status === 'needs_review') { job.draft = job.document; delete job.textReview; delete job.document; }
          start(job); return json(res, 202, { id: job.id });
        }
        if (req.method === 'GET' && match[2] === 'download') {
          const format = new URL(req.url, `http://${host}`).searchParams.get('format');
          if (format !== 'json' && !job.document) return json(res, 409, { error: '正文尚未生成完成。' });
          const filename = `${job.plan?.title || job.product}-文本草稿.${format === 'json' ? 'json' : 'txt'}`;
          res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
          return res.end(format === 'json' ? JSON.stringify(job, null, 2) : '\uFEFF' + formatDocument(job.document));
        }
      }
      return json(res, 404, { error: '未找到此页面或接口。' });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: ['输入内容过长。', '请求格式不正确。'].includes(error.message) ? error.message : '请求处理失败，请稍后重试。' });
      else res.end();
    }
  });
  return { server, jobs, controllers };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = loadConfig();
    const { server } = createApp(config);
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口${config.port}已被占用，请设置 PATENT_TEXT_PORT 更换端口。` : '服务启动失败。'); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => console.log(`专利文本工作台：http://127.0.0.1:${config.port}\n文本接口：${config.providers.length ? '已配置' : '未配置，请检查 .env.local'}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
