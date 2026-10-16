// Wraps an existing text-service acceptance case in explicit UI test metadata.
// This does not claim that preliminary logic review or human preview confirmation
// occurred in that text-only run. Text, real preview bytes and CAD are unmodified.
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readAiConfig } from '../../server/drawingAi.ts';
import { signProductArtifact, verifyProductArtifact } from '../../server/productProof.ts';
import { LOGIC_DIMENSIONS, PREVIEW_VIEWS, imageReference, isProductWorkflow } from '../../src/features/product/productWorkflow.ts';
const sourcePath=process.env.DRAWING_ACCEPTANCE_SOURCE || 'artifacts/patent-drawing-2026-10-14/complex-clamp/source-with-vision-images.json';
const root=process.env.DRAWING_ACCEPTANCE_DIR || 'artifacts/patent-drawing-2026-10-14/final-clamp';
const source=JSON.parse(await fs.readFile(sourcePath,'utf8')),config=readAiConfig(process.env), now=new Date().toISOString();
const images=PREVIEW_VIEWS.map(v=>source.previews.images.find(i=>i.templateId===v.templateId));
for(const i of images){
  verifyProductArtifact('image',imageReference(i),config);
  if(createHash('sha256').update(Buffer.from(i.dataUrl.split(',')[1],'base64')).digest('hex')!==i.digest)throw new Error('Preview digest mismatch');
}
const review=signProductArtifact('review',{id:source.brief.reviewId,selection:source.selection,createdAt:now,verdict:'feasible',summary:'仅供 Word 导出回归的流程元数据，未调用初步逻辑模型。',
  checks:Object.keys(LOGIC_DIMENSIONS).map(dimension=>({dimension,status:'assumption',explanation:'此项属于导出测试装配条件，不作为真实逻辑验收结论。'})),conflicts:[],assumptions:['原始文本用例仅实际执行结构生成、结构复核、正文生成和正文复核。']},config);
const digest=createHash('sha256').update(images.map(i=>`${i.templateId}:${i.digest}`).join('\n')).digest('hex');
const previews={...signProductArtifact('preview',{id:randomUUID(),briefId:source.brief.id,viewIds:PREVIEW_VIEWS.map(v=>v.id),digest,createdAt:now},config),images};
const confirmation=signProductArtifact('confirmation',{briefId:source.brief.id,previewId:previews.id,previewDigest:digest,confirmedAt:now},config);
const materials=JSON.parse(await fs.readFile(`${root}/accepted-materials.json`,'utf8'));
const workflow={version:2,sourceFingerprint:`drawing-export-acceptance:${source.brief.signature}`,selection:source.selection,review,brief:source.brief,previews,confirmation,textStructure:source.structure,textDraft:source.draft,materials,figures:{},redrawCount:0,updatedAt:now};
if(!isProductWorkflow(workflow))throw new Error('Invalid export fixture');
await fs.writeFile(`${root}/workflow-source.json`,JSON.stringify(workflow));
await fs.writeFile(`${root}/workflow-fixture-provenance.json`,JSON.stringify({sourcePath,realTextAndPreviewUnchanged:true,preliminaryLogicReview:'Explicit export fixture, not a real model run',previewConfirmation:'Explicit export fixture, not a recorded human UI action'},null,2));
console.log('Prepared explicit Word export fixture with unchanged real source content');
