// Replays an independently verified modelling decision through the unmodified
// application CAD pipeline. Geometry, SVGs and visual review are rebuilt live.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { readAiConfig } from '../../server/drawingAi.ts';
import { buildProductCad, cadDecisionErrors } from '../../server/productCad.ts';
import { readCadCheckpoint, saveCadCheckpoint } from '../../server/cadCheckpoint.ts';
import { verifyProductArtifact } from '../../server/productProof.ts';
import { drawingMarks, drawingPlanErrors, drawingCoverageErrors } from '../../src/features/product/productDrawing.ts';
if(process.env.RUN_PATENT_DRAWING_LIVE!=='1')throw new Error('Live acceptance opt-in required');
const root=process.env.DRAWING_ACCEPTANCE_DIR || 'artifacts/patent-drawing-2026-10-14/final-clamp';
const sourcePath=process.env.DRAWING_ACCEPTANCE_SOURCE || 'artifacts/patent-drawing-2026-10-14/complex-clamp/source-with-vision-images.json';
const decisionPath=process.env.DRAWING_DECISION || 'artifacts/patent-drawing-2026-10-14/experiment-text-cad/verified-decision.json';
const sourceBytes=await fs.readFile(sourcePath), source=JSON.parse(sourceBytes), decision=JSON.parse(await fs.readFile(decisionPath,'utf8'));
const dir=await fs.mkdtemp(path.join(tmpdir(),'drawing-acceptance-'));
const config={...readAiConfig(process.env),cadCheckpointDir:dir};
await fs.mkdir(root,{recursive:true});
const started=Date.now();
let reviewAttempt=0;
const fetcher=async(url,init)=>{
  const payload=JSON.parse(init.body);
  if(String(payload.messages?.[0]?.content).includes('独立图文核对员')){
    const checkpoint=await readCadCheckpoint(source.brief,config);
    const out=`${root}/review-attempt-${reviewAttempt++}`;await fs.mkdir(out,{recursive:true});
    if(checkpoint?.rendered)for(const [i,v]of checkpoint.rendered.views.entries())await fs.writeFile(`${out}/figure-${i+1}.png`,new Resvg(v.svg).render().asPng());
  }
  return fetch(url,init);
};
try {
  verifyProductArtifact('brief',source.brief,config);
  const errors=[...cadDecisionErrors(decision),...drawingPlanErrors(decision.drawingPlan,drawingMarks(source.brief))];
  if(errors.length)throw new Error(errors.join(';'));
  await saveCadCheckpoint(source.brief,{decision,pendingMaterials:source.materials,draftSignature:source.draft?.signature || source.textDraft?.signature || ''},config);
  const cad=await buildProductCad(source.brief,source.visionImages || source.previews.images.map(i=>({templateId:i.templateId,dataUrl:i.dataUrl})),config,AbortSignal.timeout(1800000),fetcher,(label,detail)=>console.log(`${label}: ${detail}`));
  const coverage=drawingCoverageErrors(cad,source.brief);if(coverage.length)throw new Error(coverage.join(';'));
  await fs.writeFile(`${root}/cad.json`,JSON.stringify(cad,null,2));
  for(const [i,v]of cad.views.entries()){
    await fs.writeFile(`${root}/figure-${i+1}.svg`,v.svg);
    await fs.writeFile(`${root}/figure-${i+1}.png`,new Resvg(v.svg).render().asPng());
  }
  const report={passed:true,mode:'Verified decision replay through buildProductCad; fresh geometry, projection and real visual review',sourcePath,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex'),figureCount:cad.views.length,triangles:cad.triangleCount,marks:drawingMarks(source.brief),review:cad.visualReview,elapsedMs:Date.now()-started};
  await fs.writeFile(`${root}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){const report={passed:false,code:e.code,message:e.message,details:e.details,elapsedMs:Date.now()-started};await fs.writeFile(`${root}/report.json`,JSON.stringify(report,null,2));console.error(JSON.stringify(report));process.exitCode=1;}
finally{await fs.rm(dir,{recursive:true,force:true});}
