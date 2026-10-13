const fs=require('node:fs'),path=require('node:path'),postcss=require('postcss');
const inventory=JSON.parse(fs.readFileSync('artifacts/code-redundancy-2026-10-12/inventory.json','utf8'));
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(d,x.name)):[path.join(d,x.name).replaceAll('\\','/')]);}
const files=['src','server','tests'].flatMap(walk);
const blocks=new Map();
for(const f of files.filter(f=>/\.(?:tsx?|mjs)$/.test(f))){const lines=fs.readFileSync(f,'utf8').split(/\r?\n/);for(let i=0;i<=lines.length-10;i++){const block=lines.slice(i,i+10).map(x=>x.trim()).join('\n');if(block.length<450||block.includes('import ')||block.includes('export '))continue;if(!blocks.has(block))blocks.set(block,[]);blocks.get(block).push({file:f,line:i+1});}}
const matches=[...blocks].filter(([b,g])=>new Set(g.map(x=>x.file)).size>1&&g.some(x=>x.file.startsWith('src/')||x.file.startsWith('server/'))).sort((a,b)=>b[0].length-a[0].length);
const selected=[];for(const [block,group] of matches){if(selected.some(x=>x.group.some(a=>group.some(b=>a.file===b.file&&Math.abs(a.line-b.line)<12))))continue;selected.push({length:block.length,group,block});}
const css=[];
for(const f of files.filter(f=>f.endsWith('.css'))){const text=fs.readFileSync(f,'utf8'),rules=[];postcss.parse(text,{from:f}).walkRules(rule=>rules.push({selector:rule.selector,line:rule.source.start.line,body:rule.nodes.filter(x=>x.type==='decl').map(x=>x.toString()).join(';')}));css.push({file:f,lines:text.split('\n').length,bytes:Buffer.byteLength(text),browserReachable:inventory.browserModules.includes(f),rules:rules.length});}
const out={css,duplicates:selected};fs.writeFileSync('artifacts/code-redundancy-2026-10-12/duplicates.json',JSON.stringify(out,null,2));console.log(JSON.stringify({css,duplicates:selected.slice(0,15)},null,2));
