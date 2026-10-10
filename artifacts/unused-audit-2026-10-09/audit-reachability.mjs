import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd(), out=path.join(root,'artifacts/unused-audit-2026-10-09');
const relative=f=>path.relative(root,f).replaceAll('\\','/');
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const files=['src','server','tests'].flatMap(d=>walk(path.join(root,d))).filter(f=>/\.(tsx?|mjs)$/.test(f)).concat(['vite.config.ts'].map(f=>path.join(root,f)));
const options={target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,allowJs:true,allowImportingTsExtensions:true,skipLibCheck:true,noEmit:true,noUnusedLocals:true,noUnusedParameters:true};
const program=ts.createProgram(files,options), checker=program.getTypeChecker();
const sources=files.map(f=>program.getSourceFile(f)).filter(Boolean);
const bySym=new Map(), byDecl=new Map(), nodes=new Map();
const alias=s=>s?.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(s):s;
const loc=n=>({file:relative(n.getSourceFile().fileName),line:n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1});
for(const sf of sources) {
 const file=relative(sf.fileName);nodes.set(file+'#module',{id:file+'#module',file,line:1,name:'<module>',kind:'module',deps:new Set()});
 for(const stmt of sf.statements){
  const ds=ts.isVariableStatement(stmt)?stmt.declarationList.declarations:[stmt];
  for(const d of ds) if((ts.isFunctionDeclaration(d)||ts.isVariableDeclaration(d)||ts.isClassDeclaration(d)||ts.isEnumDeclaration(d))&&d.name&&ts.isIdentifier(d.name)) {
   const s=alias(checker.getSymbolAtLocation(d.name));if(!s)continue;
   const node={id:file+'#'+d.name.text,...loc(d),name:d.name.text,kind:ts.SyntaxKind[d.kind],exported:!!stmt.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword),deps:new Set()};
   bySym.set(s,node);byDecl.set(d,node);nodes.set(node.id,node);
  }
 }
}
const isType=n=>{let p=n.parent;while(p&&!ts.isSourceFile(p)){if(ts.isTypeNode(p)||ts.isInterfaceDeclaration(p)||ts.isTypeAliasDeclaration(p))return true;p=p.parent;}return false;};
const owner=n=>{let p=n;while(p&&!ts.isSourceFile(p)){const node=byDecl.get(p);if(node)return node;p=p.parent;}return nodes.get(relative(n.getSourceFile().fileName)+'#module');};
const importOnly=n=>{let p=n;while(p&&!ts.isSourceFile(p)){if(ts.isImportDeclaration(p)||ts.isExportDeclaration(p)||ts.isExportAssignment(p))return true;p=p.parent;}return false;};
for(const sf of sources){
 const file=relative(sf.fileName), module=nodes.get(file+'#module');
 for(const stmt of sf.statements) {
  if(ts.isImportDeclaration(stmt)&&ts.isStringLiteral(stmt.moduleSpecifier)&&!stmt.importClause?.isTypeOnly) {
   if(stmt.importClause?.namedBindings&&ts.isNamedImports(stmt.importClause.namedBindings)&&!stmt.importClause.name&&stmt.importClause.namedBindings.elements.every(e=>e.isTypeOnly))continue;
   const resolved=ts.resolveModuleName(stmt.moduleSpecifier.text,sf.fileName,options,ts.sys).resolvedModule;
   if(resolved&&nodes.has(relative(resolved.resolvedFileName)+'#module'))module.deps.add(relative(resolved.resolvedFileName)+'#module');
  }
  if(ts.isVariableStatement(stmt))for(const d of stmt.declarationList.declarations){
   const init=d.initializer,node=byDecl.get(d);if(init&&node&&(ts.isCallExpression(init)||ts.isNewExpression(init)||ts.isAwaitExpression(init)))module.deps.add(node.id);
  }
  if(ts.isExportAssignment(stmt)&&!ts.isIdentifier(stmt.expression)){
   const visit=n=>{if(ts.isIdentifier(n)&&!isType(n)){const dest=bySym.get(alias(checker.getSymbolAtLocation(n)));if(dest)module.deps.add(dest.id);}ts.forEachChild(n,visit);};visit(stmt.expression);
  }
 }
 const visit=n=>{
  if(ts.isIdentifier(n)&&!isType(n)&&!importOnly(n)){
   const p=n.parent;
   if(p.name===n&&(ts.isFunctionDeclaration(p)||ts.isVariableDeclaration(p)||ts.isClassDeclaration(p)||ts.isEnumDeclaration(p)))return;
   const sym=alias(ts.isShorthandPropertyAssignment(p)?checker.getShorthandAssignmentValueSymbol(p):checker.getSymbolAtLocation(n));
   const dest=bySym.get(sym), src=owner(n);if(dest&&src&&dest!==src)src.deps.add(dest.id);
  }ts.forEachChild(n,visit);
 };visit(sf);
}
const roots=['src/main.tsx#module','server/index.ts#module','vite.config.ts#module'];
const reachable=new Set(roots),stack=[...roots];while(stack.length){for(const d of nodes.get(stack.pop())?.deps||[])if(!reachable.has(d)){reachable.add(d);stack.push(d);}}
const unreachable=[...nodes.values()].filter(n=>(n.file.startsWith('src/')||n.file.startsWith('server/'))&&n.kind!=='module'&&!reachable.has(n.id)).map(n=>({...n,deps:[...n.deps],incoming:[...nodes.values()].filter(x=>x.deps.has(n.id)).map(x=>x.id)}));
const diagnostics=program.getSemanticDiagnostics().filter(d=>[6133,6192,6196,6198].includes(d.code)&&d.file&&!relative(d.file.fileName).startsWith('tests/')).map(d=>({file:relative(d.file.fileName),line:d.file.getLineAndCharacterOfPosition(d.start||0).line+1,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
fs.writeFileSync(path.join(out,'reachability-analysis.json'),JSON.stringify({roots,diagnostics,unreachable,nodes:[...nodes.values()].map(n=>({...n,deps:[...n.deps]}))},null,2));
console.log(JSON.stringify({diagnostics,unreachable:unreachable.map(({name,file,line,exported,incoming})=>({name,file,line,exported,incoming}))},null,2));
