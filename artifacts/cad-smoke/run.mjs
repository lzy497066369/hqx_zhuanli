import fs from 'node:fs/promises';
import { resolveFreeCad, runFreeCad, renderCadViews, validateCadScript } from '../../server/productCad.ts';
const script = `import FreeCAD
from FreeCAD import Vector
import Part
import math

def build_model():
    # 1 轨道底座
    base = Part.makeBox(240, 80, 14, Vector(0, 0, 0))
    slot = Part.makeBox(200, 16, 8, Vector(20, 32, 6))
    base = base.cut(slot)
    # 2 夹持座
    seat = Part.makeBox(50, 60, 40, Vector(80, 10, 14))
    # 3 锁紧螺栓
    bolt = Part.makeCylinder(5, 30, Vector(105, 40, 54), Vector(0, 0, 1))
    head = Part.makeCylinder(9, 6, Vector(105, 40, 84), Vector(0, 0, 1))
    return {'1': base, '2': seat, '3': bolt.fuse(head)}
`;
console.log('validate:', validateCadScript(script));
const cmd = await resolveFreeCad({ baseUrl: '', apiKey: '', model: '' });
console.log('freecad:', cmd);
const t = Date.now();
const run = await runFreeCad(script, cmd, { timeoutMs: 120000 });
console.log('run ms', Date.now() - t, 'version', run.version, 'verts', run.mesh.vertices.length, 'tris', run.mesh.triangles.length, 'bbox', run.bbox);
const t2 = Date.now();
const views = renderCadViews(run.mesh, '测试', { point:[105,40,87], radius:14 });
console.log('render ms', Date.now() - t2);
for (const v of views) { await fs.writeFile(`artifacts/cad-smoke/${v.view}.svg`, v.svg); console.log(v.view, v.svg.length, 'bytes'); }
