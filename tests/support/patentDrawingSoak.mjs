import fs from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { renderPlannedFigures, withCadSlot } from '../../server/cadResources.ts';
const fixture=JSON.parse(await fs.readFile(process.env.DRAWING_SOAK_FIXTURE || 'artifacts/patent-drawing-2026-10-14/verified/cad-fixture.json','utf8'));
const duration=Number(process.env.DRAWING_SOAK_SECONDS || 900)*1000;
const start=performance.now(), delay=monitorEventLoopDelay({resolution:20});delay.enable();
const samples=[], failures=[];let cycles=0, cancelled=0;
while(performance.now()-start < duration){
  const jobs=Array.from({length:6},(_,i)=>{
    const c=new AbortController();
    const task=withCadSlot(c.signal,()=>renderPlannedFigures(fixture.run,fixture.plan,fixture.title || '标号与剖视验证',c.signal));
    if(i===4)c.abort();
    return task.then(views=>{
      if(views.some((v,n)=>v.digest!==fixture.views[n].digest))throw new Error('Non-deterministic output');
      cycles++;
    }).catch(error=>{if(error.code==='AI_CANCELLED')cancelled++;else failures.push({code:error.code,message:error.message});});
  });
  await Promise.all(jobs);
  if(cycles%100===0){samples.push({seconds:Math.round((performance.now()-start)/1000),cycles,...process.memoryUsage()});console.log(JSON.stringify(samples.at(-1)));}
}
delay.disable();
const report={passed:failures.length===0,seconds:(performance.now()-start)/1000,cycles,cancelled,failures,samples,eventLoopP99Ms:delay.percentile(99)/1e6};
await fs.writeFile(process.env.DRAWING_SOAK_REPORT || 'artifacts/patent-drawing-2026-10-14/soak-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
