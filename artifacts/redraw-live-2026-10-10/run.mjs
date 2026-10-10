import fs from 'node:fs/promises';
import { readAiConfig } from '../../server/drawingAi.ts';
import { createProductWorkflowService, PRODUCT_PATHS } from '../../server/productWorkflowAi.ts';
const root = 'artifacts/redraw-live-2026-10-10';
const config = readAiConfig(process.env);
const requests = [];
const fetcher = async (url, init) => { const t = Date.now(); const r = await fetch(url, init); requests.push({ url: String(url).split('/').slice(-2).join('/'), status: r.status, ms: Date.now() - t }); return r; };
const service = createProductWorkflowService(config, fetcher);
const log = (label, detail) => console.log(`[${new Date().toISOString().slice(11,19)}] ${label}: ${detail}`);
const signal = AbortSignal.timeout(1500000);
const old = JSON.parse(await fs.readFile('artifacts/product-workflow-2026-10-10/live-workflow.json', 'utf8'));
const state = { selection: old.selection };
const save = () => fs.writeFile(`${root}/state.json`, JSON.stringify({ ...state, requests }, null, 2));
try {
  state.review = await service(PRODUCT_PATHS.review, { selection: state.selection }, signal, log); await save();
  console.log('REVIEW', state.review.verdict, state.review.summary.slice(0, 80));
  if (state.review.verdict !== 'feasible') throw new Error('conflicts; see state.json');
  state.brief = await service(PRODUCT_PATHS.brief, { review: state.review }, signal, log); await save();
  console.log('BRIEF', state.brief.design.title, state.brief.design.components.map(c => c.number + c.name).join('/'));
  // 重画：既改视觉也改结构，看模型是直接返回完整方案还是先追问
  const input = { text: '把压板改成带手拧旋钮的快拆压板，不用工具就能松开；主体用深蓝色，并把滑槽锁紧结构画得更清楚。', directions: ['重点结构表达更清晰', '根据我的描述调整产品结构'], answers: [] };
  let dialogue, rounds = 0, response;
  for (;;) {
    rounds++;
    response = await service(PRODUCT_PATHS.revise, { brief: state.brief, dialogue, input: rounds === 1 ? input : { text: '', directions: [], answers: dialogue.questions.map(q => ({ questionId: q.id, text: q.options[0] })) } }, signal, log);
    console.log('REVISE round', rounds, response.status, response.status === 'needs_information' ? JSON.stringify(response.dialogue.questions.map(q => q.question)) : response.summary);
    if (response.status === 'ready' || rounds >= 4) break;
    dialogue = response.dialogue;
  }
  if (response.status !== 'ready') throw new Error('revise never became ready');
  state.revision = response; await save();
  console.log('NEW SELECTION choices', response.selection.choices.length, 'visual:', response.selection.visualPreferences.slice(0, 100));
  state.review2 = await service(PRODUCT_PATHS.review, { selection: response.selection }, signal, log); await save();
  console.log('REVIEW2', state.review2.verdict);
  if (state.review2.verdict !== 'feasible') throw new Error('conflicts after redraw; see state.json');
  state.brief2 = await service(PRODUCT_PATHS.brief, { review: state.review2 }, signal, log); await save();
  console.log('BRIEF2', state.brief2.design.title, state.brief2.design.components.map(c => c.number + c.name).join('/'));
  state.previews = await service(PRODUCT_PATHS.preview, { brief: state.brief2 }, signal, log);
  for (const image of state.previews.images) await fs.writeFile(`${root}/${image.templateId}.${image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`, Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  state.previews = { ...state.previews, images: state.previews.images.map(i => ({ ...i, dataUrl: '[saved]' })) }; await save();
  console.log('PREVIEWS', state.previews.images.length, 'DONE');
} catch (error) { await save(); console.error('FAILED', error.code || '', error.message, (error.details || []).join(' | ')); process.exitCode = 1; }
console.log('REQUESTS', JSON.stringify(requests));
