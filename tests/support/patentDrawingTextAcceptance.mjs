// Independent final acceptance against the actual generated claims/specification.
// Does not generate, rewrite or patch any technical prose.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readAiConfig } from '../../server/drawingAi.ts';
import { signProductArtifact } from '../../server/productProof.ts';
import { visionConfig } from '../../server/productCad.ts';
import { reviewCadDrawings } from '../../server/cadVisualReview.ts';
import { drawingCoverageErrors, drawingMarks, drawingManifestDigest } from '../../src/features/product/productDrawing.ts';
if(process.env.RUN_PATENT_DRAWING_LIVE !== '1')throw new Error('Live acceptance opt-in required.');
const root=process.env.DRAWING_ACCEPTANCE_DIR || 'artifacts/patent-drawing-2026-10-14/live-readable';
const sourcePath=process.env.DRAWING_ACCEPTANCE_SOURCE || 'artifacts/patent-performance-2026-10-13/state.json';
const sourceBytes=await fs.readFile(sourcePath), source=JSON.parse(sourceBytes), cad=JSON.parse(await fs.readFile(`${root}/cad.json`,'utf8'));
const bodyFields=['abstract','claims','technicalField','background','content','embodiment'];
const content=Object.fromEntries(bodyFields.map(k=>[k,source.materials[k]]));
content.drawings=cad.views.map((v,i)=>`图${i+1}为本产品的${v.title}。`).join('\n')+'\n附图标记：'+drawingMarks(source.brief).map(m=>`${m.number}、${m.name}`).join('；')+'。';
const errors=drawingCoverageErrors(cad,source.brief);
if(errors.length)throw new Error(errors.join(';'));
const text=bodyFields.map(k=>Array.isArray(content[k])?content[k].join('\n'):content[k]).join('\n');
const referenced=[...new Set([...text.matchAll(/[（(]([1-9]\d{0,2})[）)]/g)].map(m=>m[1]))];
const drawn=[...new Set(cad.views.flatMap(v=>v.annotations.map(a=>a.number)))];
if(referenced.some(n=>!drawn.includes(n)))throw new Error('Text mark absent from drawings');
const mapping=drawingMarks(source.brief).map(m=>({...m,inActualText:text.includes(m.name),figures:cad.views.map((v,i)=>v.annotations.some(a=>a.number===m.number)?i+1:0).filter(Boolean)}));
if(mapping.some(m=>!m.inActualText||!m.figures.length))throw new Error('One-to-one text/figure mapping failed');
const report={passed:false,sourcePath,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex'),technicalTextSha256:createHash('sha256').update(JSON.stringify(Object.fromEntries(bodyFields.map(k=>[k,content[k]])))).digest('hex'),
  figureCount:cad.views.length,drawingDigest:drawingManifestDigest(cad),mapping,technicalTextUnchanged:true,drawingsDescriptionBoundToActualManifest:true,startedAt:new Date().toISOString()};
try {
  report.review=await reviewCadDrawings(source.brief,cad.drawingPlan,cad.views,visionConfig(readAiConfig(process.env)),AbortSignal.timeout(900000),fetch,content);
  report.passed=true;const {signature:_signature,...unsigned}={...source.materials,...content,briefId:source.brief.id,title:source.brief.design.title,createdAt:new Date().toISOString(),drawingDigest:report.drawingDigest,drawingReview:report.review};
  const materials=signProductArtifact('materials',unsigned,readAiConfig(process.env));
  await fs.writeFile(`${root}/accepted-materials.json`,JSON.stringify(materials,null,2));
}catch(e){report.error={code:e.code,message:e.message,details:e.details};process.exitCode=1;}
report.finishedAt=new Date().toISOString();await fs.writeFile(`${root}/text-acceptance.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
