// Reuses verified geometry only when every geometry-affecting input is identical.
import fs from 'node:fs/promises';
import { meshDigest } from '../../server/meshFigure.ts';
import { renderPlannedFigures } from '../../server/cadResources.ts';
const root='artifacts/patent-drawing-2026-10-14/final-clamp';
const fixture=JSON.parse(await fs.readFile(`${root}/soak-fixture-v6.json`,'utf8'));
const original=JSON.parse(await fs.readFile('artifacts/patent-drawing-2026-10-14/experiment-text-cad/verified-eight-decision.json','utf8'));
const cad=JSON.parse(await fs.readFile(`${root}/cad.json`,'utf8'));
const geometry=f=>JSON.stringify({id:f.id,state:f.state,parts:f.parts,section:f.section});
if(cad.script!==original.script || cad.meshDigest!==meshDigest(fixture.run.mesh) || cad.drawingPlan.figures.some((f,i)=>geometry(f)!==geometry(fixture.plan.figures[i])))throw new Error('Geometry changed; a fresh FreeCAD run is required');
const views=await renderPlannedFigures(fixture.run,cad.drawingPlan,fixture.title,AbortSignal.timeout(120000));
if(views.some((v,i)=>v.digest!==cad.views[i].digest))throw new Error('Final figure digest mismatch');
await fs.writeFile(`${root}/soak-fixture-final.json`,JSON.stringify({...fixture,plan:cad.drawingPlan,views}));
console.log(JSON.stringify({passed:true,allFinalViewsIdentical:true,figures:views.length}));
