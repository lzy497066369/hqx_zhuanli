import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
const root='artifacts/patent-drawing-2026-10-14', zip=new JSZip();
for(const [name,dir]of [['复杂夹具','final-clamp'],['光伏支架','final-bracket-corrected']]){
  const base=path.join(root,dir);
  const report=JSON.parse(await fs.readFile(path.join(base,'text-acceptance.json'),'utf8'));
  const word=JSON.parse(await fs.readFile(path.join(base,'word-audit.json'),'utf8'));
  const pdf=JSON.parse(await fs.readFile(path.join(base,'word-render/pdf-audit.json'),'utf8'));
  if(!report.passed||!word.passed||!pdf.passed)throw new Error(`Unverified package: ${name}`);
  const files=['patent-with-verified-drawings.docx','word-render/patent.pdf','text-acceptance.json','word-audit.json','word-render/pdf-audit.json'];
  for(let i=1;i<=report.figureCount;i++)files.push(`figure-${i}.png`,`figure-${i}.svg`);
  for(const file of files)zip.file(`${name}/${file}`,await fs.readFile(path.join(base,file)));
}
const final=JSON.parse(await fs.readFile(path.join(root,'final-clamp/acceptance.json'),'utf8'));
if(!final.passed)throw new Error('Final acceptance missing');
for(const f of ['验收报告.md','acceptance.json'])zip.file(f,await fs.readFile(path.join(root,'final-clamp',f)));
await fs.writeFile(path.join(root,'专利附图验收成品.zip'),await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log(JSON.stringify({packaged:true,file:path.join(root,'专利附图验收成品.zip')}));
