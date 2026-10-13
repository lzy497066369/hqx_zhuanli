const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = process.cwd();
const out = path.join(root, 'artifacts/code-redundancy-2026-10-12');
function walk(dir) { return fs.readdirSync(dir, {withFileTypes:true}).flatMap(x => x.isDirectory() ? walk(path.join(dir,x.name)) : [path.join(dir,x.name)]); }
const paths = ['src','server','tests','deploy','docs'].flatMap(x=>walk(path.join(root,x))).concat(fs.readdirSync(root).filter(x=>/\.(?:[cm]?js|tsx?|css)$/.test(x)).map(x=>path.join(root,x)));
const files = paths.filter(x=>/\.(?:[cm]?js|tsx?)$/.test(x));
const rel = x=>path.relative(root,x).replaceAll('\\','/');
const sources = new Map(files.map(f=>[f,ts.createSourceFile(f,fs.readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true)]));
const edge = new Map(), runtime = new Map(), imports = [], exportItems = [], functions = [];
function resolve(from,spec) { if(!spec.startsWith('.'))return;const base=path.resolve(path.dirname(from),spec); return [base,...['.ts','.tsx','.js','.mjs','.cjs','.css'].map(ext=>base+ext),path.join(base,'index.ts')].find(x=>fs.existsSync(x)&&fs.statSync(x).isFile()); }
const printer = ts.createPrinter({removeComments:true});
for(const [f,sf] of sources) {
  edge.set(f,[]);runtime.set(f,[]);
  function dep(spec,types,names) { const target=resolve(f,spec);if(target){edge.get(f).push(target);if(!types)runtime.get(f).push(target);imports.push({from:rel(f),target:rel(target),types,names});} }
  function visit(n) {
    if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)) {
      const c=n.importClause;const names=[];if(c?.name)names.push('default');
      if(c?.namedBindings){if(ts.isNamedImports(c.namedBindings))names.push(...c.namedBindings.elements.map(x=>x.propertyName?.text||x.name.text));else names.push('*');}
      const types=!!c&&(c.isTypeOnly||(!c.name&&c.namedBindings&&ts.isNamedImports(c.namedBindings)&&c.namedBindings.elements.every(x=>x.isTypeOnly)));
      dep(n.moduleSpecifier.text,types,names);
    }
    if(ts.isExportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))dep(n.moduleSpecifier.text,n.isTypeOnly,['*']);
    if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword&&ts.isStringLiteral(n.arguments[0]))dep(n.arguments[0].text,false,['*']);
    if(n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) {
      const kind=ts.SyntaxKind[n.kind]; const type=ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n);
      if(n.name)exportItems.push({file:rel(f),name:n.name.text,kind,type,line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1});
      if(ts.isVariableStatement(n))for(const d of n.declarationList.declarations)if(ts.isIdentifier(d.name))exportItems.push({file:rel(f),name:d.name.text,kind,type:false,line:sf.getLineAndCharacterOfPosition(d.getStart()).line+1});
    }
    if((ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n))&&n.body) {
      const body=printer.printNode(ts.EmitHint.Unspecified,n.body,sf).replace(/\s+/g,' ').trim();
      if(body.length>=160)functions.push({file:rel(f),name:n.name?.text||n.parent?.name?.text||'<anonymous>',line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,length:body.length,body});
    }
    ts.forEachChild(n,visit);
  }
  visit(sf);
}
function reachable(graph,roots){const seen=new Set();function go(f){if(seen.has(f))return;seen.add(f);for(const d of graph.get(f)||[])go(d);}roots.forEach(x=>go(path.join(root,x)));return seen;}
const browser=reachable(runtime,['src/main.tsx']);
const server=reachable(runtime,['server/index.ts','vite.config.ts']);
const production=new Set([...browser,...server]);
const prodFull=reachable(edge,['src/main.tsx','server/index.ts','vite.config.ts']);
const testFiles=files.filter(x=>rel(x).startsWith('tests/'));
const tests=reachable(edge,testFiles.map(rel));
const prodFiles=files.filter(x=>/^(src|server)\//.test(rel(x)));
const candidates=exportItems.map(e=>({...e,consumers:imports.filter(i=>i.target===e.file&&(i.names.includes(e.name)||i.names.includes('*'))).map(i=>({file:i.from,production:prodFull.has(path.join(root,i.from)),types:i.types}))}));
const groups=new Map();for(const f of functions){if(!groups.has(f.body))groups.set(f.body,[]);groups.get(f.body).push(f);}
const duplicateFunctions=[...groups.values()].filter(g=>g.length>1).map(g=>g.map(({body,...f})=>f)).sort((a,b)=>b[0].length-a[0].length);
const program=ts.createProgram(files,{allowJs:true,checkJs:false,noEmit:true,allowImportingTsExtensions:true,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ESNext});
const checker=program.getTypeChecker(), symbols=new Map(), usages=new Map();
for(const f of prodFiles){const sf=program.getSourceFile(f);const mod=checker.getSymbolAtLocation(sf);if(!mod)continue;for(const sym of checker.getExportsOfModule(mod)){const dec=sym.valueDeclaration||sym.declarations?.find(d=>ts.isTypeAliasDeclaration(d)||ts.isInterfaceDeclaration(d));if(!dec||!dec.name||!ts.isIdentifier(dec.name))continue;symbols.set(sym,{file:rel(f),name:sym.name,line:sf.getLineAndCharacterOfPosition(dec.name.getStart()).line+1});}}
function targetSymbol(n){let sym=ts.isShorthandPropertyAssignment(n.parent)?checker.getShorthandAssignmentValueSymbol(n.parent):checker.getSymbolAtLocation(n);if(sym?.flags&ts.SymbolFlags.Alias){try{sym=checker.getAliasedSymbol(sym);}catch{}}return sym;}
for(const f of files){const sf=program.getSourceFile(f);if(!sf)continue;function visit(n){if(ts.isIdentifier(n)){
const parent=n.parent;
const declarationName=parent.name===n&&(ts.isDeclarationStatement(parent)||ts.isVariableDeclaration(parent)||ts.isParameter(parent)||ts.isPropertyDeclaration(parent)||ts.isMethodDeclaration(parent)||ts.isPropertySignature(parent)||ts.isImportSpecifier(parent)||ts.isImportClause(parent)||ts.isNamespaceImport(parent)||ts.isBindingElement(parent));
if(!declarationName&&!ts.isExportSpecifier(parent)&&!ts.isImportSpecifier(parent)){const sym=targetSymbol(n);if(symbols.has(sym)){if(!usages.has(sym))usages.set(sym,[]);usages.get(sym).push({file:rel(f),line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1,production:production.has(f)});}}
}ts.forEachChild(n,visit);}visit(sf);}
const symbolUsage=[...symbols].map(([s,d])=>({...d,refs:usages.get(s)||[]}));
const result={counts:{sourceFiles:prodFiles.length,allScriptFiles:files.length,browserModules:browser.size,serverModules:server.size},unreachableProduction:prodFiles.filter(f=>!production.has(f)).map(f=>({file:rel(f),lines:sources.get(f).text.split('\n').length,typeReachable:prodFull.has(f),testReachable:tests.has(f)})),unconsumedExports:candidates.filter(e=>!e.consumers.length),testOnlyExports:candidates.filter(e=>e.consumers.length&&!e.consumers.some(c=>c.production)),unusedSymbols:symbolUsage.filter(x=>!x.refs.length),nonProductionSymbols:symbolUsage.filter(x=>x.refs.length&&!x.refs.some(r=>r.production)),duplicateFunctions,browserModules:[...browser].map(rel).sort(),imports};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'type-inventory.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({counts:result.counts,unreachableProduction:result.unreachableProduction,unusedSymbols:result.unusedSymbols,nonProductionSymbols:result.nonProductionSymbols.map(({refs,...x})=>({...x,consumers:[...new Set(refs.map(r=>r.file))]})),duplicateFunctions:duplicateFunctions.filter(g=>g.some(x=>/^(src|server)\//.test(x.file)))},null,2));
