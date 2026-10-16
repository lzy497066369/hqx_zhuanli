// Uses the main application's already generated frozen technical plan and final prose.
// Only image calls are made; text is copied byte-for-byte into the acceptance record.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAiConfig } from '../../server/drawingAi.ts';
import { generateProductImage } from '../../server/productImages.ts';
import { checkTextDocument } from '../../src/features/product/productText.ts';
import { isProductBrief } from '../../src/features/product/productWorkflow.ts';
import { verifyProductArtifact } from '../../server/productProof.ts';
if(process.env.RUN_PATENT_DRAWING_LIVE !== '1')throw new Error('Explicit live opt-in required.');
const sourcePath=process.env.COMPLEX_TEXT_SOURCE || 'artifacts/product-text-context-refactor-2026-10-14/live/夹具-1.json';
const root=path.resolve(process.env.COMPLEX_DRAWING_OUTPUT || 'artifacts/patent-drawing-2026-10-14/complex-clamp');
await fs.mkdir(root,{recursive:true});
const original=await fs.readFile(sourcePath), source=JSON.parse(original), config=readAiConfig(process.env);
if(!isProductBrief(source.brief))throw new Error('Invalid source brief');
verifyProductArtifact('brief',source.brief,config);
const errors=checkTextDocument(source.materials.textRecord.document,source.brief.technicalSource.plan);
if(errors.length || source.materials.textRecord.status!=='completed')throw new Error('Source text not complete: '+errors.join(';'));
await fs.writeFile(path.join(root,'original-text-source.json'),original);
const record={sourcePath,sourceSha256:createHash('sha256').update(original).digest('hex'),textSha256:createHash('sha256').update(JSON.stringify(source.materials.textRecord.document)).digest('hex'),
  title:source.brief.design.title,parts:source.brief.technicalSource.plan.parts.map(p=>({number:p.id,name:p.name,kind:p.kind,parent:p.parentId})),startedAt:new Date().toISOString()};
await fs.writeFile(path.join(root,'source-provenance.json'),JSON.stringify(record,null,2));
const images=[];
async function view(id,hero){
  const file=path.join(root,id+'.json');
  try{const image=JSON.parse(await fs.readFile(file,'utf8'));if(image.briefId===source.brief.id){images.push(image);return image;}}catch{}
  console.log('Generating '+id);
  const image=await generateProductImage(source.brief,'preview',id,config,AbortSignal.timeout(240000),fetch,hero);
  await fs.writeFile(file,JSON.stringify(image));await fs.writeFile(path.join(root,id+'.png'),Buffer.from(image.dataUrl.split(',')[1],'base64'));
  images.push(image);console.log('Saved '+id);return image;
}
try{
  const hero=await view('color-hero');
  const results=await Promise.allSettled(['color-front','color-top','color-right'].map(id=>view(id,hero)));
  const failures=results.filter(r=>r.status==='rejected');if(failures.length)throw failures[0].reason;
  const state={...source,previews:{images}};
  await fs.writeFile(path.join(root,'source-with-previews.json'),JSON.stringify(state));
  console.log(JSON.stringify({passed:true,views:images.length,sourceUnchanged:true,output:root}));
}catch(e){await fs.writeFile(path.join(root,'preview-failure.json'),JSON.stringify({code:e.code,message:e.message},null,2));console.error(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;}
