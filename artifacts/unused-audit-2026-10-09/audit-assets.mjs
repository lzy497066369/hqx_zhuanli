import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
const root=process.cwd(),out=path.join(root,'artifacts/unused-audit-2026-10-09');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const rel=f=>path.relative(root,f).replaceAll('\\','/');
const source=walk(path.join(root,'src')).filter(f=>/\.(tsx?|css)$/.test(f));
const text=source.filter(f=>/\.tsx?$/.test(f)).map(f=>fs.readFileSync(f,'utf8')).join('\n');
const reach=JSON.parse(fs.readFileSync(path.join(out,'static-analysis.json'),'utf8')).frontendReach;
const styles=source.filter(f=>f.endsWith('.css')).map(f=>{
 const css=postcss.parse(fs.readFileSync(f,'utf8'),{from:f}), classes=new Map();
 css.walkRules(r=>{for(const match of r.selector.matchAll(/\.(-?[_a-zA-Z]+[-_a-zA-Z0-9]*)/g)) if(!classes.has(match[1]))classes.set(match[1],r.source.start.line);});
 return {file:rel(f),reachable:reach.includes(rel(f)),selectors:classes.size,noLiteralReference:[...classes].filter(([name])=>!text.includes(name)).map(([name,line])=>({name,line}))};
});
const assets=walk(path.join(root,'public')).map(f=>{const url='/'+path.relative(path.join(root,'public'),f).replaceAll('\\','/');return {file:rel(f),bytes:fs.statSync(f).size,url,referencedByApplication:(text+fs.readFileSync(path.join(root,'index.html'),'utf8')).includes(url)};});
fs.writeFileSync(path.join(out,'asset-analysis.json'),JSON.stringify({styles,assets},null,2));
console.log(JSON.stringify({styles,assets},null,2));
