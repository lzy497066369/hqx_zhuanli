const fs=require('node:fs'),ts=require('typescript');
const plan={
 'tests/fixtures/structureFlow.ts':['skeletonResponse','mockStructure','openNamedWorkspace','generateStructure','confirmSkeleton','savedProject'],
 'tests/fixtures/materialsV2.ts':['mockMaterialsV2','generateMaterialsV2'],
 'tests/utility-patent-structure.spec.ts':['mockAnswers'],
 'src/features/utility/drawingModel.ts':['FIGURE_NAMES'],
};
for(const [file,names]of Object.entries(plan)){let text=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),spans=[];for(const n of sf.statements){const name=n.name?.text||(ts.isVariableStatement(n)&&n.declarationList.declarations.length===1?n.declarationList.declarations[0].name.text:undefined);if(names.includes(name))spans.push([n.getFullStart(),n.end]);}if(spans.length!==names.length)throw Error(file);for(const [start,end]of spans.sort((a,b)=>b[0]-a[0]))text=text.slice(0,start)+text.slice(end);fs.writeFileSync(file,text);}
// Trim imports made obsolete by the helper removal, leaving fixture data intact.
const unusedImports={
 'tests/fixtures/structureFlow.ts':["import { expect } from '@playwright/test';","import type { Page } from '@playwright/test';","import { patentStructureSource } from '../../src/features/utility/patentStructure';","import { mockNaming } from './namingAi';","import { researchFixture } from './research';"],
 'tests/fixtures/materialsV2.ts':["import { expect } from '@playwright/test';","import type { Page } from '@playwright/test';"],
 'tests/utility-patent-structure.spec.ts':["import type { Page } from '@playwright/test';"],
};
for(const [file,imports]of Object.entries(unusedImports)){let text=fs.readFileSync(file,'utf8');for(const line of imports)text=text.replace(line+'\r\n','').replace(line+'\n','');fs.writeFileSync(file,text);}
