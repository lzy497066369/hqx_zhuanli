import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { drawingMarks, drawingPlanErrors, drawingCoverageErrors, drawingManifestDigest } from '../src/features/product/productDrawing.ts';
import { meshDigest, renderMeshView } from '../server/meshFigure.ts';
import { resolveFreeCad, runFreeCad } from '../server/productCad.ts';
import { renderPlannedFigures, withCadSlot } from '../server/cadResources.ts';
import { readCadCheckpoint, saveCadCheckpoint } from '../server/cadCheckpoint.ts';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const drawingTestScript = `import Part
from FreeCAD import Vector
def build_model():
    base = Part.makeBox(120,80,6).cut(Part.makeCylinder(5,6,Vector(100,60,0)))
    block = Part.makeBox(20,20,20,Vector(40,30,6))
    pin = Part.makeCylinder(3,6,Vector(50,40,26))
    return {"1":base,"2":block,"3":pin}
`;
const marks = [
  { number: '1', name: '底座', owner: '1', kind: 'part' },
  { number: '2', name: '安装座', owner: '2', kind: 'part' },
  { number: '3', name: '定位销', owner: '3', kind: 'part' },
  { number: '7', name: '安装孔', owner: '1', kind: 'opening' },
];
const brief = { design: { components: marks.filter(m => m.owner === m.number) }, technicalSource: { plan: { parts: marks.map(m => ({ id: m.number, name: m.name, kind: m.kind, parentId: m.number === m.owner ? null : m.owner })) } } };
export const drawingTestPlan = { version: 1, anchors: [{ number: '7', owner: '1', point: [105,60,6] }], figures: [
  { id: 'figure-1', title: '整体结构示意图', kind: 'overall', purpose: '整体装配及安装孔位置', direction: [1,-.75,.8], up: [0,0,1], marks: ['1','2','3','7'] },
  { id: 'figure-2', title: '安装座与定位销的剖视图', kind: 'section', purpose: '销与安装座的连接', direction: [0,-1,0], up: [0,0,1], marks: ['1','2','3'], section: { axis: 'y', offset: 40, keep: 'positive' } },
] };

test('Drawing plan preserves non-contiguous original IDs and includes openings', () => {
  assert.deepEqual(drawingMarks(brief), marks);
  assert.deepEqual(drawingPlanErrors(drawingTestPlan, marks), []);
  const missing = structuredClone(drawingTestPlan); missing.figures[0].marks.pop();
  assert.match(drawingPlanErrors(missing, marks).join(), /漏标.*7/);
  const wrong = structuredClone(drawingTestPlan); wrong.anchors[0].owner = '2';
  assert.match(drawingPlanErrors(wrong, marks).join(), /所属实体/);
  const state = structuredClone(drawingTestPlan); state.figures[1].kind='state'; delete state.figures[1].section;
  assert.match(drawingPlanErrors(state, marks).join(), /状态模型/);
  assert.deepEqual(drawingPlanErrors({ ...drawingTestPlan, figures: [drawingTestPlan.figures[0]] }, marks), []);
  for (const malformed of [{marks:{}}, {kind:'detail',parts:'1'}, {direction:null}]) {
    const bad=structuredClone(drawingTestPlan);Object.assign(bad.figures[0],malformed);
    assert.ok(drawingPlanErrors(bad,marks).length);
  }
  const alias = structuredClone(drawingTestPlan); alias.figures[1].depth = .1;
  assert.deepEqual(drawingPlanErrors(alias, marks), []);
  for (const depth of [0, .01, 51, '0.1', NaN]) {
    const bad = structuredClone(alias); bad.figures[1].depth = depth;
    assert.match(drawingPlanErrors(bad, marks).join(), /厚度/);
  }
  const conflict = structuredClone(alias); conflict.figures[1].section.depth = .2;
  assert.match(drawingPlanErrors(conflict, marks).join(), /厚度不一致/);
  const nonSection = structuredClone(drawingTestPlan); nonSection.figures[0].depth = .1;
  assert.match(drawingPlanErrors(nonSection, marks).join(), /非剖视图/);
});

test('Renderer refuses geometry truncation instead of silently omitting structure', () => {
  assert.throws(() => renderMeshView({ vertices: [[0,0,0],[1,0,0],[0,1,1]], triangles: Array(120001).fill([0,1,2]) }, { direction:[0,-1,0] }), /不能截断/);
});

test('CAD resource queue bounds work, releases cancelled waiters, and recovers', async () => {
  let running=0, maximum=0;
  const releases=[];
  const work=()=>new Promise(resolve=>{ running++; maximum=Math.max(maximum,running); releases.push(()=>{running--;resolve();}); });
  const a=withCadSlot(new AbortController().signal,work), b=withCadSlot(new AbortController().signal,work);
  const controller=new AbortController();
  const c=withCadSlot(controller.signal,work); controller.abort();
  await assert.rejects(c,{code:'AI_CANCELLED'});
  const d=withCadSlot(new AbortController().signal,work);
  releases.shift()(); await a; await new Promise(resolve=>setImmediate(resolve));
  releases.shift()(); releases.shift()(); await Promise.all([b,d]);
  assert.equal(maximum,2); assert.equal(running,0);
  await withCadSlot(new AbortController().signal,async()=>{});
});

test('Private signed checkpoints survive service restart and reject tampering', async () => {
  const dir=await fs.mkdtemp(path.join(tmpdir(),'drawing-checkpoint-test-'));
  const config={apiKey:'test-only-key',model:'test',cadCheckpointDir:dir}, brief={signature:'test-brief'};
  try {
    const record={decision:{summary:'test',script:drawingTestScript,assumptions:[],drawingPlan:drawingTestPlan}};
    await saveCadCheckpoint(brief,record,config);
    assert.deepEqual(await readCadCheckpoint(brief,{...config}),record);
    assert.equal(await readCadCheckpoint(brief,{...config,apiKey:'changed-key'}),undefined);
    const file=path.join(dir,(await fs.readdir(dir))[0]);
    const modified=JSON.parse(await fs.readFile(file,'utf8'));modified.checkpoint.decision.script+='changed';
    await fs.writeFile(file,JSON.stringify(modified));
    assert.equal(await readCadCheckpoint(brief,config),undefined);
    assert.equal(await readCadCheckpoint({signature:'different-brief'},config),undefined);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('FreeCAD preserves repeated solids and constructs genuine alternate states', {timeout:180000}, async()=>{
  const command=await resolveFreeCad({});assert.ok(command);
  const compoundScript='import Part\nfrom FreeCAD import Vector\ndef build_model():\n    a=Part.makeBox(10,10,10)\n    b=Part.makeBox(10,10,10,Vector(20,0,0))\n    return {"1":Part.makeCompound([a,b])}\n';
  const repeat=await runFreeCad(compoundScript,command);assert.equal(repeat.mesh.triangles.length,24);
  const stateScript=drawingTestScript+'\ndef build_state(state, parts):\n    if state == "moved":\n        parts["2"].translate(Vector(10,0,0))\n        parts["3"].translate(Vector(10,0,0))\n    return parts\n';
  const plan=structuredClone(drawingTestPlan);
  plan.figures[1]={...plan.figures[0],id:'figure-2',kind:'state',state:'moved',title:'移动后状态',purpose:'同一装配中移动件的位置变化'};
  const run=await runFreeCad(stateScript,command,{plan,components:['1','2','3']});
  assert.notDeepEqual(run.figures[0].mesh.vertices,run.figures[1].mesh.vertices);
  const views=await renderPlannedFigures(run,plan,'状态验证',new AbortController().signal);assert.equal(views.length,2);
  const wrong=stateScript.replace('parts["2"].translate(Vector(10,0,0))','parts["2"] = Part.makeBox(5,5,5)');
  await assert.rejects(runFreeCad(wrong,command,{plan,components:['1','2','3']}),{code:'CAD_SCRIPT_FAILED'});
  const repeated=structuredClone(plan);
  repeated.figures.push({...plan.figures[1],id:'figure-3',kind:'section',direction:[0,-1,0],section:{axis:'y',offset:40,keep:'positive'}});
  repeated.figures.push({...plan.figures[1],id:'figure-4'});
  const cached=await runFreeCad(stateScript,command,{plan:repeated,components:['1','2','3']});
  assert.deepEqual(cached.figures[1].mesh,cached.figures[3].mesh,'A section must leave the shared state intact for later whole views');
  assert.ok(cached.figures[2].mesh.vertices.every(point=>point[1]>=39.999));
  const floating=stateScript.replace('parts["3"].translate(Vector(10,0,0))','parts["3"].translate(Vector(1000,0,0))');
  await assert.rejects(runFreeCad(floating,command,{plan:repeated,components:['1','2','3']}),error=>{
    assert.equal(error.code,'CAD_SCRIPT_FAILED');assert.match(error.details.join(' '),/disconnected.*3\(instance 1\)/);return true;
  });
});

test('Exact contact connectivity rejects nested gaps and retains indirect connections', {timeout:180000}, async()=>{
  const command=await resolveFreeCad({});assert.ok(command);
  const plan={version:1,anchors:[],figures:[{id:'figure-1',title:'连接检查',kind:'overall',purpose:'实体接触',direction:[1,-1,1],up:[0,0,1],marks:['1']}]};
  const nested='import Part\nfrom FreeCAD import Vector\ndef build_model():\n    ring=Part.makeCylinder(20,10).cut(Part.makeCylinder(15,10))\n    pin=Part.makeCylinder(5,10)\n    return {"1":Part.makeCompound([ring,pin])}\n';
  await assert.rejects(runFreeCad(nested,command,{plan,components:['1']}),error=>{
    assert.equal(error.code,'CAD_SCRIPT_FAILED');assert.match(error.details.join(' '),/disconnected.*1\(instance 2\)/);return true;
  });
  const linked='import Part\nfrom FreeCAD import Vector\ndef build_model():\n    left=Part.makeBox(10,10,10)\n    right=Part.makeBox(10,10,10,Vector(20,0,0))\n    bridge=Part.makeBox(10,10,10,Vector(10,0,0))\n    return {"1":Part.makeCompound([left,right,bridge])}\n';
  const run=await runFreeCad(linked,command,{plan,components:['1']});
  assert.deepEqual(run.bbox,[0,0,0,30,10,10]);
});

test('Real FreeCAD produces consistent whole/section drawings with full verified callouts', { timeout:180000 }, async () => {
  const command=await resolveFreeCad({});
  assert.ok(command,'FreeCAD is required for this verification');
  const run=await runFreeCad(drawingTestScript,command,{plan:drawingTestPlan,components:['1','2','3'],timeoutMs:120000});
  const views=await renderPlannedFigures(run,drawingTestPlan,'标号与剖视验证',new AbortController().signal);
  assert.equal(views.length,2);
  assert.deepEqual(views[0].annotations.map(a=>a.number).sort(),['1','2','3','7']);
  assert.ok(views[1].svg.includes('section-hatch'));
  const cad={drawingVersion:1,drawingPlan:drawingTestPlan,views};
  assert.deepEqual(drawingCoverageErrors(cad,brief),[]);
  const digest=drawingManifestDigest(cad); const missing=structuredClone(cad); missing.views.pop();
  assert.notEqual(drawingManifestDigest(missing),digest);
  assert.ok(drawingCoverageErrors(missing,brief).length);
  for(const view of views) for(const a of view.annotations) {
    assert.ok(a.anchor[0]>=0 && a.anchor[0]<view.width && a.anchor[1]>=0 && a.anchor[1]<view.height);
    assert.equal(a.owner,marks.find(m=>m.number===a.number).owner);
  }
  await fs.mkdir('artifacts/patent-drawing-2026-10-14/verified',{recursive:true});
  for(const view of views) await fs.writeFile(`artifacts/patent-drawing-2026-10-14/verified/${view.view}.svg`,view.svg);
  await fs.writeFile('artifacts/patent-drawing-2026-10-14/verified/cad-fixture.json',JSON.stringify({run,plan:drawingTestPlan,views}));
  const zoom=structuredClone(drawingTestPlan);zoom.figures[1].focus={point:[50,40,20],radius:30};
  const zoomed=await renderPlannedFigures(run,zoom,'局部剖视验证',new AbortController().signal);
  assert.ok(zoomed[1].svg.includes('detail-window'));
  assert.deepEqual(zoomed[1].annotations.map(a=>a.number).sort(),['1','2','3']);
  const slice=structuredClone(zoom);slice.figures[1].section.depth=.1;
  const sliced=await runFreeCad(drawingTestScript,command,{plan:slice,components:['1','2','3']});
  assert.ok(sliced.figures[1].mesh.vertices.every(v=>v[1]>=39.999 && v[1]<=40.101));
  const sliceViews=await renderPlannedFigures(sliced,slice,'局部断面验证',new AbortController().signal);
  assert.deepEqual(sliceViews[1].annotations.map(a=>a.number).sort(),['1','2','3']);
  const aliasSlice=structuredClone(slice);aliasSlice.figures[1].depth=aliasSlice.figures[1].section.depth;delete aliasSlice.figures[1].section.depth;
  const aliasRun=await runFreeCad(drawingTestScript,command,{plan:aliasSlice,components:['1','2','3']});
  assert.ok(aliasRun.figures[1].mesh.vertices.every(v=>v[1]>=39.999 && v[1]<=40.101),'Figure depth must limit real geometry to the requested thin section');
  assert.equal(meshDigest(aliasRun.figures[1].mesh),meshDigest(sliced.figures[1].mesh));
  const invalid=structuredClone(drawingTestPlan); invalid.anchors[0].point=[110,60,12];
  await assert.rejects(runFreeCad(drawingTestScript,command,{plan:invalid,components:['1','2','3']}),{code:'CAD_SCRIPT_FAILED'});
  const hidden=structuredClone(drawingTestPlan); hidden.figures[0].direction=[0,0,-1]; hidden.figures[0].up=[0,1,0];
  await assert.rejects(renderPlannedFigures(run,hidden,'遮挡测试',new AbortController().signal),{code:'CAD_DRAWING_INVALID'});
  const hiddenWholeSet=structuredClone(hidden);
  hiddenWholeSet.figures[1].direction=[0,0,-1]; hiddenWholeSet.figures[1].up=[0,1,0];
  await assert.rejects(renderPlannedFigures(run,hiddenWholeSet,'整套遮挡检查',new AbortController().signal),error=>{
    assert.equal(error.code,'CAD_DRAWING_INVALID');
    assert.equal(error.details.length,2,'Each figure finding must remain a separate diagnostic');
    assert.match(error.details[0],/图1/); assert.match(error.details[1],/图2/);
    assert.match(error.details.join(' '),/图1.*图2|图2.*图1/);
    return true;
  });
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(runFreeCad(drawingTestScript,command,{signal:cancelled.signal}),{code:'AI_CANCELLED'});
});

test('Compound sections preserve every overlapping constituent and state gap annotations use real surfaces', {timeout:180000}, async()=>{
  const command=await resolveFreeCad({});assert.ok(command);
  const script=`import Part
from FreeCAD import Vector
def build_model():
    base=Part.makeBox(80,40,5)
    wall=Part.makeBox(8,40,45,Vector(0,0,5))
    cap=Part.makeBox(80,40,5,Vector(0,0,45))
    upper=Part.makeBox(30,30,4,Vector(8,5,30))
    lower=Part.makeBox(30,30,4,Vector(8,5,26))
    return {"1":Part.makeCompound([base,wall,cap]),"2":upper,"3":lower}
def build_state(state, parts):
    parts['3'].translate(Vector(0,0,-1))
    return parts
`;
  const plan={version:1,anchors:[],figures:[
    {id:'figure-1',title:'整机',kind:'overall',purpose:'三个连接部件',direction:[1,-1,1],up:[0,0,1],marks:['1','2','3']},
    {id:'figure-2',title:'脱离间隙断面',kind:'section',state:'separated',purpose:'真实1毫米间隙',direction:[0,-1,0],up:[0,0,1],marks:['1','2','3'],section:{axis:'y',offset:20,keep:'positive',depth:.1},focus:{point:[30,20,25],radius:35},
      dimensions:[{axis:'z',from:{owner:'2',point:[20,20,30]},to:{owner:'3',point:[20,20,29]}}]}
  ]};
  assert.deepEqual(drawingPlanErrors(plan),[]);
  const run=await runFreeCad(script,command,{plan,components:['1','2','3']});
  const cut=run.figures[1].mesh;
  const one=new Set(cut.triangles.flatMap((t,i)=>cut.parts[i]==='1'?t:[]));
  const coordinates=[...one].map(i=>cut.vertices[i]);
  assert.equal(Math.min(...coordinates.map(p=>p[2])),0);
  assert.equal(Math.max(...coordinates.map(p=>p[2])),50);
  assert.ok(coordinates.some(p=>p[0]===80 && p[2]===5));
  assert.ok(coordinates.some(p=>p[0]===80 && p[2]===45));
  const views=await renderPlannedFigures(run,plan,'实际间隙',new AbortController().signal);
  assert.match(views[1].svg,/data-dimension="1 mm"/);
  assert.match(views[1].svg,/section-hatch-1-1/);
  assert.match(views[1].svg,/section-hatch-1-2/);
  assert.match(views[1].svg,/section-hatch-1-3/);
  const hatches=[...views[1].svg.matchAll(/<pattern id="section-hatch-1-\d+"[^>]*patternTransform="rotate\(([^)]+)\)"/g)].map(m=>m[1]);
  assert.ok(new Set(hatches).size>=2,'Separate constituents need visibly different section patterns');
  const invalid=structuredClone(plan);invalid.figures[1].dimensions[0].from.point=[20,20.05,32];
  await assert.rejects(runFreeCad(script,command,{plan:invalid,components:['1','2','3']}),error => {
    assert.equal(error.code,'CAD_SCRIPT_FAILED');
    assert.match(error.details.join(' '),/figure-2 dimension from.*owner 2 point.*nearest actual boundary/);
    return true;
  });
  const invalidMarks=structuredClone(plan);
  invalidMarks.anchors=[{number:'1',owner:'1',point:[40,20,20]},{number:'2',owner:'2',point:[23,20,32]}];
  await assert.rejects(runFreeCad(script,command,{plan:invalidMarks,components:['1','2','3']}),error => {
    assert.equal(error.code,'CAD_SCRIPT_FAILED');
    assert.equal(error.details.length,2);
    assert.match(error.details[0],/anchor mark 1 owner 1/);
    assert.match(error.details[1],/anchor mark 2 owner 2/);
    return true;
  });
});

test('Surface inscriptions are readable, face-bound and rejected if hidden or over an opening', {timeout:180000}, async()=>{
  const command=await resolveFreeCad({});assert.ok(command);
  const plan={version:1,anchors:[],figures:[{id:'figure-1',title:'表面状态标识',kind:'overall',purpose:'真实字体标识',direction:[0,0,1],up:[0,1,0],marks:['1'],surfaceTexts:[{text:'开启',owner:'1',point:[30,25,6],height:3}]}]};
  const script='import Part\nfrom FreeCAD import Vector\ndef build_model():\n    return {"1":Part.makeBox(80,50,6).cut(Part.makeCylinder(7,6,Vector(55,25,0)))}\n';
  const run=await runFreeCad(script,command,{plan,components:['1']});
  const views=await renderPlannedFigures(run,plan,'表面字体验证',new AbortController().signal);
  assert.match(views[0].svg,/data-surface-owner="1"[^>]*>开启<\/text>/);
  const small = structuredClone(plan); small.figures[0].surfaceTexts[0].height = .1;
  const readable = await renderPlannedFigures(run, small, '小字保持可读', new AbortController().signal);
  assert.match(readable[0].svg, /data-surface-owner="1"[^>]*font-size="18"[^>]*>开启<\/text>/);
  const nearHole = structuredClone(small); nearHole.figures[0].surfaceTexts[0].point = [47.6,25,6];
  await assert.rejects(renderPlannedFigures(run, nearHole, '字号扩大后不能覆盖孔口', new AbortController().signal), error => {
    assert.equal(error.code, 'CAD_DRAWING_INVALID'); assert.match(error.details.join(' '), /完整可见/); return true;
  });
  const hole=structuredClone(plan);hole.figures[0].surfaceTexts[0].point=[55,25,6];
  await assert.rejects(renderPlannedFigures(run,hole,'遮挡文字',new AbortController().signal),{code:'CAD_DRAWING_INVALID'});
  const hidden=structuredClone(plan);hidden.figures[0].direction=[0,0,-1];
  await assert.rejects(renderPlannedFigures(run,hidden,'背面文字',new AbortController().signal),{code:'CAD_DRAWING_INVALID'});
});

test('Local callouts attach to visible physical contours, away from artificial crop edges', {timeout:120000}, async()=>{
  const command=await resolveFreeCad({});assert.ok(command);
  const run=await runFreeCad('import Part\nfrom FreeCAD import Vector\ndef build_model():\n    return {"1":Part.makeBox(600,40,10,Vector(-300,-20,0))}\n',command);
  const result=renderMeshView(run.mesh,{direction:[.35,1,.9],up:[0,0,1],focus:{point:[0,0,5],radius:70},partLabels:true,requiredLabels:['1'],forceLabelParts:['1']});
  assert.deepEqual(result.labelledParts,['1']);
  const [x,y]=result.annotations[0].anchor;
  assert.ok(x>358 && x<1042 && y>158 && y<842,'Leader must not end at an artificial crop boundary');
  const contours=result.svg.match(/<g\b[^>]*stroke-width="1.6"[^>]*>([\s\S]*?)<\/g>/)[1];
  const segments=[...contours.matchAll(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/g)];
  const nearest=Math.min(...segments.map(m=>{
    const [ax,ay,bx,by]=m.slice(1).map(Number),dx=bx-ax,dy=by-ay;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(x-ax-t*dx,y-ay-t*dy);
  }));
  assert.ok(nearest<=3.5,'Leader endpoint must be visibly grounded in a real contour');
});
