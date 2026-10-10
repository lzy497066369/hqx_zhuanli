import { generateNamingOptions } from './server/namingAi.ts';
import { readAiConfig } from './server/drawingAi.ts';

const config = readAiConfig(process.env);
const raw: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  const clone = response.clone();
  try {
    const body = JSON.parse(await clone.text());
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.includes('"options"')) raw.push(content);
  } catch { /* ignore */ }
  return response;
};

const businesses = process.argv.slice(2);
for (const business of businesses) {
  raw.length = 0;
  try {
    const result = await generateNamingOptions({ company: '测试公司', business }, config, new AbortController().signal, fetcher);
    console.log(`✅ ${business} → ${result.options.length} 个：${result.options.map(option => option.product).join('、')}`);
  } catch (error) {
    console.log(`❌ ${business} → ${(error as { code?: string }).code} ${(error as Error).message}`);
    console.log(`   模型原始：${raw.at(-1)?.slice(0, 1200) || '（未捕获）'}`);
  }
}
