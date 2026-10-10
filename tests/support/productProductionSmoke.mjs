import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['--experimental-strip-types', '--env-file-if-exists=.env.local', 'server/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs=''; child.stdout.on('data', value => { logs+=value; }); child.stderr.on('data', value => { logs+=value; });
try {
  const base=`http://127.0.0.1:${port}`; let root;
  for(let attempt=0;attempt<50;attempt++) { if(child.exitCode !== null) throw new Error('Production server exited: '+logs.slice(0,1500)); try { root=await fetch(base); if(root.ok)break; } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
  if(!root?.ok)throw new Error('Production startup timed out');
  const assetHtml = await root.text();
  const invalid=await fetch(base+'/api/product/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({selection:{}})});
  const invalidBody=await invalid.json();
  const secret=await fetch(base+'/.env.local');
  if(invalid.status!==400 || invalidBody.error?.code!=='PRODUCT_SELECTION_INVALID' || secret.status!==404)throw new Error('Production route/security smoke failed');
  let leaked=false; const files=await fs.readdir('dist/assets');
  const envText=await fs.readFile('.env.local','utf8'); const keys=[...envText.matchAll(/^AI_(?:IMAGE_)?API_KEY=(.+)$/gm)].map(match=>match[1].trim());
  for(const file of files.filter(file=>file.endsWith('.js'))) { const bytes=await fs.readFile('dist/assets/'+file,'utf8'); if(keys.some(key=>key && bytes.includes(key))) leaked=true; }
  if(leaked)throw new Error('A server key was found in a client asset');
  const report={productionStartup:true,frontendServed:assetHtml.includes('root'),productRouteRegistered:true,envNotServed:true,clientAssetsContainNoKeys:true,port};
  await fs.writeFile('artifacts/product-workflow-2026-10-09/production-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally { child.kill(); await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);}); }
