import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.cwd();
const output = path.join(root, 'artifacts/backend-cleanup-2026-10-09');
const rel = p => path.relative(root, p).replaceAll('\\', '/');
const walk = d => fs.readdirSync(d, {withFileTypes:true}).flatMap(x => x.isDirectory() ? walk(path.join(d,x.name)) : [path.join(d,x.name)]);
const prod = ['src','server'].flatMap(d => walk(path.join(root,d))).filter(f => /\.(tsx?|mjs)$/.test(f));
const checks = walk(path.join(root,'tests')).filter(f => /\.(tsx?|mjs)$/.test(f));
const config = fs.readdirSync(root).filter(f => /\.(tsx?|mjs)$/.test(f)).map(f => path.join(root,f));
const files = [...prod, ...checks, ...config];
const options = {target:ts.ScriptTarget.ESNext, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler, jsx:ts.JsxEmit.ReactJSX, allowJs:true, checkJs:false, allowImportingTsExtensions:true, skipLibCheck:true, noEmit:true};
const program = ts.createProgram(files, options);
const checker = program.getTypeChecker();
const canon = s => { if (!s) return; try {return s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;} catch {return s;} };
const sources = new Map(files.map(f=>[f,program.getSourceFile(f)]).filter(([,s])=>s));
const at = n => ({file:rel(n.getSourceFile().fileName),line:n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1});
const kind = f => f.startsWith('tests/') || f.startsWith('tmp-') ? 'test/tool' : f === 'vite.config.ts' || f.startsWith('playwright') ? 'config' : 'production';
const declarations = [];
const bySymbol = new Map();
for (const f of prod) {
  const sf = sources.get(f); if(!sf) continue;
  const mod = checker.getSymbolAtLocation(sf);
  for (const exp of mod ? checker.getExportsOfModule(mod) : []) {
    const sym = canon(exp);
    const ds = sym?.declarations || [];
    const decl = ds.find(d=>d.getSourceFile()===sf); if(!decl) continue;
    if (!ds.some(d=>ts.isFunctionDeclaration(d)||ts.isVariableDeclaration(d)||ts.isClassDeclaration(d)||ts.isEnumDeclaration(d))) continue;
    const item = {name:exp.name, ...at(decl), kind:ts.SyntaxKind[decl.kind], references:[], declaration:decl, symbol:sym};
    declarations.push(item); bySymbol.set(sym,item);
  }
}
for (const [f,sf] of sources) {
  const visit = n => {
    if(ts.isIdentifier(n) || ts.isJsxNamespacedName(n)) {
      const sym = canon(checker.getSymbolAtLocation(n)); const item = bySymbol.get(sym);
      if (item) {
        const p=n.parent;
        const isDeclaration = p && p.name === n && (ts.isFunctionDeclaration(p)||ts.isVariableDeclaration(p)||ts.isClassDeclaration(p)||ts.isEnumDeclaration(p));
        const isImport = p && (ts.isImportSpecifier(p)||ts.isImportClause(p)||ts.isNamespaceImport(p)||ts.isExportSpecifier(p));
        if(!isDeclaration && !isImport) {
          let q=n; while(q.parent && q.parent!==sf) q=q.parent;
          const self = item.declaration.getSourceFile()===sf && n.pos>=item.declaration.pos && n.end<=item.declaration.end;
          if(!self) item.references.push({...at(n),kind:kind(rel(f)),context:q.getText(sf).slice(0,100).replace(/\s+/g,' ')});
        }
      }
    }
    ts.forEachChild(n,visit);
  }; visit(sf);
}
const modules=[];
for(const [f,sf] of sources) {
  const imports=[];
  const visit = n => {
    let spec;
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)) {
      spec=n.moduleSpecifier.text;
      if(ts.isImportDeclaration(n) && (n.importClause?.isTypeOnly || (n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) && !n.importClause.name && n.importClause.namedBindings.elements.every(e=>e.isTypeOnly)))) spec=undefined;
      if(ts.isExportDeclaration(n)&&n.isTypeOnly) spec=undefined;
    }
    if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteral(n.arguments[0])) spec=n.arguments[0].text;
    if(spec?.startsWith('.')) {
      const resolved=ts.resolveModuleName(spec,f,options,ts.sys).resolvedModule;
      if(resolved) imports.push({file:rel(resolved.resolvedFileName),line:at(n).line});
      else { const raw=path.resolve(path.dirname(f),spec); if(fs.existsSync(raw)) imports.push({file:rel(raw),line:at(n).line}); }
    }
    ts.forEachChild(n,visit);
  };visit(sf);
  modules.push({file:rel(f),imports});
}
const entrypoints=['src/main.tsx','server/index.ts','vite.config.ts'];
const reachFrom=(entries)=> { const seen=new Set(entries), stack=[...entries];const map=new Map(modules.map(x=>[x.file,x])); while(stack.length){ const f=stack.pop();for(const i of map.get(f)?.imports||[]) if(!seen.has(i.file)){seen.add(i.file);stack.push(i.file);} } return [...seen].sort(); };
const reachable=reachFrom(entrypoints);
const frontendReach=reachFrom(['src/main.tsx']);
const backendReach=reachFrom(['server/index.ts','vite.config.ts']);
const exports=declarations.map(({declaration,symbol,...rest})=> ({...rest,productionReferences:rest.references.filter(r=>r.kind==='production'||r.kind==='config').length,testReferences:rest.references.filter(r=>r.kind==='test/tool').length}));
const analysis={scope:{productionFiles:prod.length,testAndToolFiles:checks.length+config.length,entrypoints},unreachableModules:prod.map(rel).filter(f=>!reachable.includes(f)),frontendUnreachable:prod.map(rel).filter(f=>f.startsWith('src/')&&!frontendReach.includes(f)),zeroReferences:exports.filter(x=>!x.references.length),testOnlyReferences:exports.filter(x=>x.references.length&&!x.productionReferences),exports,modules,frontendReach,backendReach};
fs.writeFileSync(path.join(output,'static-analysis.json'),JSON.stringify(analysis,null,2));
const allSource=['src','server'].flatMap(d=>walk(path.join(root,d)));
fs.writeFileSync(path.join(output,'source-hashes.json'),JSON.stringify(Object.fromEntries(allSource.map(f=>[rel(f),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')])),null,2));
console.log(JSON.stringify({scope:analysis.scope,unreachableModules:analysis.unreachableModules,frontendUnreachable:analysis.frontendUnreachable,zeroReferences:analysis.zeroReferences.map(({name,file,line})=>({name,file,line})),testOnlyReferences:analysis.testOnlyReferences.map(({name,file,line,testReferences})=>({name,file,line,testReferences}))},null,2));
