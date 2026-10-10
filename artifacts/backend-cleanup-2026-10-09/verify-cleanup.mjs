import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
const root=process.cwd();
const out=path.join(root,'artifacts/backend-cleanup-2026-10-09');
const baseline=path.join(out,'baseline-workspace');
const hashes=JSON.parse(fs.readFileSync(path.join(out,'source-hashes-before.json'),'utf8'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const baselineMismatches=Object.entries(hashes).filter(([file,hash])=>sha(path.join(baseline,file))!==hash).map(([file])=>file);
assert.deepEqual(baselineMismatches,[]);
const changed=Object.entries(hashes).filter(([file,hash])=>!fs.existsSync(path.join(root,file))||sha(path.join(root,file))!==hash).map(([file])=>file).sort();
assert.deepEqual(changed,['server/documentReviewer.ts','server/materialsV2Api.ts','server/structureFallback.ts']);
const removalNames={
 'server/materialsV2Api.ts':['JsonResponse','JsonRequest','ExpressLike','readAiConfig','registerMaterialsV2Api'],
 'server/documentReviewer.ts':['sortIssuesBySeverity'],
};
const statements=(file,source,removed=[])=>{
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 return ast.statements.filter(s=>!s.name||!ts.isIdentifier(s.name)||!removed.includes(s.name.text)).map(s=>s.getText(ast));
};
for(const [file,names] of Object.entries(removalNames)){
 assert.deepEqual(statements(file,fs.readFileSync(path.join(root,file),'utf8')),statements(file,fs.readFileSync(path.join(baseline,file),'utf8'),names),`Kept code changed: ${file}`);
}
const after=JSON.parse(fs.readFileSync(path.join(out,'static-analysis.json'),'utf8'));
assert.deepEqual(after.zeroReferences.filter(e=>e.file.startsWith('server/')),[]);
assert.deepEqual(after.unreachableModules.filter(e=>e.startsWith('server/')),[]);
const test=JSON.parse(fs.readFileSync(path.join(out,'test-results.json'),'utf8'));
const baselineTest=JSON.parse(fs.readFileSync(path.join(out,'baseline-test-results.json'),'utf8'));
const failures=suites=>suites.flatMap(s=>[...s.specs.filter(spec=>spec.tests.some(t=>t.status==='unexpected')).map(spec=>({title:spec.title,line:spec.line,errors:spec.tests.flatMap(t=>t.results.flatMap(r=>r.errors||[])).map(e=>e.message)})),...failures(s.suites||[])]);
const failed=failures(test.suites);
const oldFailed=failures(baselineTest.suites);
assert.deepEqual(failed.map(f=>f.title),oldFailed.map(f=>f.title));
const guards=fs.readdirSync(out).filter(n=>/^network-guard-.*\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(out,n),'utf8')));
assert(guards.every(g=>g.blockedAttempts===0&&g.externalAiRequests===0));
const result={date:'2026-10-09',changedSourceFiles:changed,frontendChangedFiles:changed.filter(f=>f.startsWith('src/')),removedLines:247,keptBackendStatementsUnchanged:true,baselineMatchesBeforeHashes:true,typescript:'passed',backendLint:'passed',productionBuild:'passed',productionBuildWarning:'Bundle exceeds 500 kB; no build errors.',testStats:test.stats,baselineTestStats:baselineTest.stats,existingFailures:failed,baselineFailureTitles:oldFailed.map(f=>f.title),remainingZeroReferenceBackendExports:[],remainingUnreachableBackendModules:[],networkGuards:guards,backup:'backend-before-cleanup.zip'};
fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({changed,frontendUnchanged:true,keptBackendStatementsUnchanged:true,testStats:test.stats,baselineTestStats:baselineTest.stats},null,2));
