import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const root = process.cwd();
const out = path.join(root, 'artifacts/backend-cleanup-2026-10-09');
const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const rel = file => path.relative(root, file).replaceAll('\\', '/');
const allSources = ['src', 'server'].flatMap(d => walk(path.join(root, d)));
fs.writeFileSync(path.join(out, 'source-hashes-before.json'), JSON.stringify(Object.fromEntries(allSources.map(file => [rel(file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])), null, 2));
const edits = [
  {file:'server/materialsV2Api.ts', names:['JsonResponse', 'JsonRequest', 'ExpressLike', 'readAiConfig', 'registerMaterialsV2Api']},
  {file:'server/documentReviewer.ts', names:['sortIssuesBySeverity']},
];
const summaries = [];
for (const {file,names} of edits) {
  const text = fs.readFileSync(path.join(root,file),'utf8');
  const source = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const declarations = source.statements.filter(s => s.name && ts.isIdentifier(s.name) && names.includes(s.name.text));
  if (declarations.length !== names.length) throw new Error(`Unexpected declarations in ${file}`);
  let updated = text;
  for (const declaration of [...declarations].reverse()) updated = updated.slice(0,declaration.getFullStart()) + updated.slice(declaration.end);
  const removed = declarations.map(d=>({name:d.name.text,fromLine:source.getLineAndCharacterOfPosition(d.getStart()).line+1}));
  const beforeLines=text.split('\n').length, afterLines=updated.split('\n').length;
  fs.writeFileSync(path.join(root,file),updated);
  summaries.push({file,removed,deletedLines:beforeLines-afterLines,beforeLines,afterLines});
}
const fallback = fs.readFileSync(path.join(root,'server/structureFallback.ts'),'utf8');
summaries.push({file:'server/structureFallback.ts',action:'delete-file',deletedLines:fallback.split('\n').length - (fallback.endsWith('\n')?1:0)});
fs.writeFileSync(path.join(out,'deletions.json'),JSON.stringify(summaries,null,2));
console.log(JSON.stringify(summaries,null,2));
