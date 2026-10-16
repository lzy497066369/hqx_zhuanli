import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT } from '../config.mjs';
import { join } from 'node:path';

const base = 'http://127.0.0.1:3210';
const out = join(ROOT, 'data', 'verification');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const resumeId = process.argv[2];
  if (resumeId) await page.addInitScript(id => localStorage.setItem('patent-text-last-job', id), resumeId);
  await page.goto(base);
  let id = resumeId;
  if (!resumeId) {
  await page.getByLabel('产品名称', { exact: true }).fill(process.env.PATENT_TEST_PRODUCT || '闸门');
  await page.getByRole('button', { name: '生成待解决的问题' }).click();
  await page.locator('#choices').waitFor({ state: 'visible', timeout: 240_000 });
  const choices = await page.locator('.problem strong').allTextContents();
  assert(choices.length >= 3);
  console.log(JSON.stringify({ event: 'problems_ready', choices }));
  await page.screenshot({ path: join(out, 'problems.png'), fullPage: true });
  await page.locator('input[name="problem"]').first().check();
  await page.getByRole('button', { name: '按选定问题生成完整文本' }).click();
  await page.locator('#job-section').waitFor({ state: 'visible', timeout: 15_000 });
  id = await page.evaluate(() => localStorage.getItem('patent-text-last-job'));
  } else {
    const existing = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (['failed', 'cancelled', 'needs_review'].includes(existing.status)) {
      const result = await fetch(`${base}/api/jobs/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 202);
      await page.reload();
    }
  }
  let previous = '', job;
  const deadline = Date.now() + 18 * 60_000;
  while (Date.now() < deadline) {
    job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    const state = `${job.stage}:${job.status}:${job.events.at(-1)?.message}`;
    if (previous !== state) { console.log(JSON.stringify({ event: 'progress', stage: job.stage, status: job.status, message: job.events.at(-1)?.message })); previous = state; }
    if (job.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  assert.equal(job.status, 'completed', job.error || JSON.stringify(job.textReview?.unresolved));
  await page.waitForFunction(() => document.getElementById('job-title').textContent === '已完成', { timeout: 10_000 });
  assert((await page.locator('#document').textContent()).includes('权利要求书'));
  await page.reload();
  await page.locator('#results').waitFor({ state: 'visible' });
  await page.screenshot({ path: join(out, 'completed.png'), fullPage: false });
  await page.getByRole('tab', { name: '部件与结构' }).click();
  assert(await page.locator('#panel-plan tbody tr').count() > 5);
  await page.screenshot({ path: join(out, 'structure.png'), fullPage: true });
  if (job.plan.schemaVersion === 2) {
    assert(job.plan.coreActions.length > 0);
    assert(job.plan.claimPlan.independent.length > 0);
    await page.getByRole('tab', { name: '保护方案' }).click();
    assert((await page.locator('#panel-scope').textContent()).includes('取舍理由'));
    await page.getByRole('tab', { name: '设计记录' }).click();
    assert((await page.locator('#panel-notes').textContent()).includes('后续工程验证事项'));
    assert(!/初拟|待验证事项|待确认|需按.*核定/.test(job.text), '正式正文仍残留设计阶段措辞');
  }
  await page.getByRole('tab', { name: '检查与修正' }).click();
  assert((await page.locator('#panel-review').textContent()).includes('结构检查'));
  const download = await fetch(`${base}/api/jobs/${id}/download`);
  assert.equal(download.status, 200);
  assert((await download.text()).includes(job.document.title));
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(out, 'mobile.png'), fullPage: false });
  assert.deepEqual(errors, []);
  const report = { success: true, id, title: job.document.title, parts: job.plan.parts.length, claims: job.document.claims.length, abstractLength: [...job.document.abstract].length, structureFindings: job.structureReview.findings.length, textFindings: job.textReview.findings.length, browserErrors: errors, checks: ['real API', 'problem selection', 'all generation stages', 'refresh recovery', 'structure table', 'review records', 'text download', 'mobile width'] };
  writeFileSync(join(out, 'live-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
