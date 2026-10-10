import { resolveFreeCad, runFreeCad } from '../../server/productCad.ts';
import fs from 'node:fs/promises';
const script = await fs.readFile('artifacts/cad-smoke/run.mjs','utf8').then(t => t.split('const script = `')[1].split('`;')[0]);
const cmd = await resolveFreeCad({ baseUrl:'', apiKey:'', model:'' });
const { mesh } = await runFreeCad(script, cmd, { timeoutMs: 60000 });
// head: cylinder r=9 at (105,40), z 84..90. Right view: view=[1,0,0]; screen x = dot(p,[0,1,0]) = y ; silhouette at y=31 and y=49
const head = mesh.vertices.map((v,i)=>[i,v]).filter(([,v]) => v[2] >= 83.9 && Math.hypot(v[0]-105, v[1]-40) > 8.9);
console.log('head rim verts', head.length);
const ext = head.filter(([,v]) => Math.abs(v[1]-31) < 0.3 || Math.abs(v[1]-49) < 0.3);
console.log('extreme-y rim verts', ext.map(([i,v]) => `${i}:${v.map(n=>n.toFixed(2))}`));
// find triangles touching extreme verts
const ids = new Set(ext.map(([i])=>i));
const tris = mesh.triangles.filter(t => t.some(i => ids.has(i)));
console.log('tris touching', tris.length);
for (const t of tris.slice(0, 12)) { const p = t.map(i => mesh.vertices[i]); const n = [(p[1][1]-p[0][1])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][1]-p[0][1]), (p[1][2]-p[0][2])*(p[2][0]-p[0][0])-(p[1][0]-p[0][0])*(p[2][2]-p[0][2]), (p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0])]; const l=Math.hypot(...n); console.log(t.join(','), 'n·view(x)=', (n[0]/l).toFixed(4), 'nz=', (n[2]/l).toFixed(3)); }
