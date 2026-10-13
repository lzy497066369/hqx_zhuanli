const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const removals={
  'src/features/utility/naming.ts':['RULE_VERSION','productCore','generateNames','directions','Direction'],
  'src/features/utility/aiDrawing.ts':['isPlanResponse'],
  'src/features/utility/contentDrawing.ts':['GEOMETRY_EXAMPLE'],
  'src/features/utility/drawingModel.ts':['contains'],
  'src/features/utility/figureConsistency.ts':['alignFigureSpecsToRenderedModel'],
  'src/features/utility/structureDraft.ts':['emptyStructureDraft'],
  'src/features/product/productPrompts.ts':['PREVIEW_TEMPLATE_IDS','COLOR_PREVIEW_TEMPLATE_V1'],
};
function edits(file,spans){let text=fs.readFileSync(file,'utf8');for(const [start,end,replacement='']of spans.sort((a,b)=>b[0]-a[0]))text=text.slice(0,start)+replacement+text.slice(end);fs.writeFileSync(file,text);}
for(const [file,names]of Object.entries(removals)){const source=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),spans=[];for(const n of sf.statements){const name=n.name?.text|| (ts.isVariableStatement(n)&&n.declarationList.declarations.length===1?n.declarationList.declarations[0].name.text:undefined);if(names.includes(name)){spans.push([n.getFullStart(),n.end]);console.log(file+': removed '+name);}}if(spans.length!==names.length)throw Error('Missing declaration in '+file);edits(file,spans);}
const workflow='src/features/product/productWorkflow.ts';fs.writeFileSync(workflow,fs.readFileSync(workflow,'utf8').replace('FIGURE_CATALOG, PREVIEW_TEMPLATE_IDS','FIGURE_CATALOG'));
// Remove imports left without any local identifier usage, without reorganizing
// unrelated imports or removing explicit side-effect imports.
function trimImports(file){const source=fs.readFileSync(file,'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true),uses=new Set(),spans=[];function visit(n){if(ts.isImportDeclaration(n))return;if(ts.isIdentifier(n))uses.add(n.text);ts.forEachChild(n,visit);}visit(sf);for(const n of sf.statements){if(!ts.isImportDeclaration(n)||!n.importClause)continue;const c=n.importClause,b=c.namedBindings;const keepDefault=c.name&&uses.has(c.name.text)?c.name:undefined;let keptBinding=b;
if(b&&ts.isNamedImports(b)){const elements=b.elements.filter(e=>uses.has(e.name.text));keptBinding=elements.length?ts.factory.updateNamedImports(b,elements):undefined;}else if(b&&!uses.has(b.name.text))keptBinding=undefined;
if(keepDefault===c.name&&keptBinding===b)continue;
if(!keepDefault&&!keptBinding){spans.push([n.getFullStart(),n.end]);continue;}
const updated=ts.factory.updateImportDeclaration(n,n.modifiers,ts.factory.updateImportClause(c,c.isTypeOnly,keepDefault,keptBinding),n.moduleSpecifier,n.attributes);
spans.push([n.getStart(),n.end,ts.createPrinter().printNode(ts.EmitHint.Unspecified,updated,sf)]);
}if(spans.length)edits(file,spans);}
for(const file of Object.keys(removals))trimImports(file);
