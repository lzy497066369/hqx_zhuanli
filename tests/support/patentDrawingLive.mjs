// Opt-in paid integration: use already generated text/preview; never regenerate text here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAiConfig } from '../../server/drawingAi.ts';
import { buildProductCad } from '../../server/productCad.ts';
import { Resvg } from '@resvg/resvg-js';
if (process.env.RUN_PATENT_DRAWING_LIVE !== '1') throw new Error('Set RUN_PATENT_DRAWING_LIVE=1 to use the real configured provider.');
const root=path.resolve(process.env.DRAWING_LIVE_OUTPUT || 'artifacts/patent-drawing-2026-10-14/live');
await fs.mkdir(root,{recursive:true});
const source=JSON.parse(await fs.readFile(process.env.DRAWING_LIVE_SOURCE || 'artifacts/patent-performance-2026-10-13/state.json','utf8'));
const requests=[];
const fetcher=async(url,init)=>{
  const payload=JSON.parse(init.body), index=requests.length;
  const entry={index,model:payload.model,startedAt:new Date().toISOString()};requests.push(entry);
  const response=await fetch(url,init);entry.status=response.status;
  if(response.ok){
    const body=await response.clone().text();
    await fs.writeFile(path.join(root,`response-${index}.json`),body);
  }
  entry.finishedAt=new Date().toISOString();await fs.writeFile(path.join(root,'requests.json'),JSON.stringify(requests,null,2));return response;
};
const config=readAiConfig(process.env), started=Date.now();
try{
  const images=source.visionImages || source.previews.images.map(i=>({templateId:i.templateId,dataUrl:i.dataUrl}));
  const cad=await buildProductCad(source.brief,images,config,AbortSignal.timeout(1800000),fetcher,(label,detail)=>console.log(`${label}: ${detail}`));
  await fs.writeFile(path.join(root,'cad.json'),JSON.stringify(cad,null,2));
  for(const [i,v] of cad.views.entries()){
    await fs.writeFile(path.join(root,`figure-${i+1}.svg`),v.svg);
    await fs.writeFile(path.join(root,`figure-${i+1}.png`),new Resvg(v.svg).render().asPng());
  }
  const report={passed:true,title:source.brief.design.title,figureCount:cad.views.length,figures:cad.views.map(v=>({id:v.view,title:v.title,marks:v.annotations.map(a=>a.number)})),visualReview:cad.visualReview,elapsedMs:Date.now()-started};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){
  const report={passed:false,code:e.code,message:e.message,details:e.details,elapsedMs:Date.now()-started};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1;
}
