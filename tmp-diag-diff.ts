// 把模型真实输出同时喂给「改动前」和「改动后」的判定，区分既有缺陷与新引入的回归。
import { checkName, checkProduct, isAccessorySubject, emptyProfile } from './src/features/utility/naming.ts';
import { generateNamingOptions } from './server/namingAi.ts';
import { readAiConfig } from './server/drawingAi.ts';

const config = readAiConfig(process.env);
const raw: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  try {
    const body = JSON.parse(await response.clone().text());
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.includes('"options"')) raw.push(content);
  } catch { /* ignore */ }
  return response;
};

// 改动前的 keepsProductSubject：传入客体不是具体产品时直接放行
const oldKeeps = (product: string, business: string) =>
  !!checkProduct(business.trim().replace(/^一种/u, '')).length || product.endsWith(business.trim().replace(/^一种/u, ''));
// 改动后的 keepsProtectedSubject
const newKeeps = (product: string, business: string) => {
  const value = product.trim().replace(/^一种/u, '');
  const subject = business.trim().replace(/^一种/u, '');
  if (!value || !subject) return false;
  if (['钢材', '钢铁', '金属', '塑料', '木材', '板材', '管材', '布料', '纺织品', '涂料', '化工品', '橡胶', '玻璃', '纸张', '石材', '建材'].some(m => subject.endsWith(m)))
    return value.includes(subject.slice(0, -1)) && !isAccessorySubject(value);
  return value.includes(subject) || subject.includes(value);
};

for (const business of process.argv.slice(2)) {
  raw.length = 0;
  try { await generateNamingOptions({ company: '测试公司', business }, config, new AbortController().signal, fetcher); }
  catch { /* 失败是预期的，我们只要原始输出 */ }
  const content = raw.at(-1);
  if (!content) { console.log(`${business}: 未捕获模型输出`); continue; }
  let options: { product: string; features: string[] }[] = [];
  try { options = JSON.parse(content).options || []; } catch { /* ignore */ }
  const profile = { ...emptyProfile, company: '测试公司', business };
  console.log(`\n=== ${business} ===`);
  for (const option of options) {
    const reasonOld: string[] = [];
    if (!oldKeeps(option.product, business)) reasonOld.push('主体');
    if (checkProduct(option.product).length) reasonOld.push('非具体产品(hardware正则)');
    if (checkName(`一种${option.product}`, { ...profile, product: option.product }).errors.length) reasonOld.push('checkName');
    const reasonNew = reasonOld.filter(r => r !== '主体');
    if (!newKeeps(option.product, business)) reasonNew.push('主体');
    console.log(`  ${option.product.padEnd(16, '　')} 旧:${reasonOld.length ? '拒绝[' + reasonOld.join(',') + ']' : '通过'}   新:${reasonNew.length ? '拒绝[' + reasonNew.join(',') + ']' : '通过'}`);
  }
}
