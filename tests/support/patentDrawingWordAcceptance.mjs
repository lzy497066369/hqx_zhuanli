// Exports through the actual application's Word function, without calling a model.
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { isProductWorkflow, isProductWorkflowComplete } from '../../src/features/product/productWorkflow.ts';
const root=process.env.DRAWING_ACCEPTANCE_DIR || 'artifacts/patent-drawing-2026-10-14/live-callouts';
const sourcePath=process.env.DRAWING_ACCEPTANCE_SOURCE || 'artifacts/patent-performance-2026-10-13/state.json';
const source=JSON.parse(await fs.readFile(sourcePath,'utf8'));
source.cad=JSON.parse(await fs.readFile(`${root}/cad.json`,'utf8'));
source.materials=JSON.parse(await fs.readFile(`${root}/accepted-materials.json`,'utf8'));
if(!isProductWorkflow(source)||!isProductWorkflowComplete(source))throw new Error('Cannot export an incomplete or inconsistent workflow.');
const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
try{
  const page=await browser.newPage();
  await page.route('**/api/product/**',r=>r.abort());
  await page.goto(process.env.DRAWING_EXPORT_URL || 'http://127.0.0.1:5206/');
  const encoded=await page.evaluate(async workflow=>{
    const {createProductWordBlob}=await import('/src/features/product/productWordExport.ts');
    const data=new Uint8Array(await(await createProductWordBlob(workflow)).arrayBuffer());
    let binary='';for(let i=0;i<data.length;i+=32768)binary+=String.fromCharCode(...data.subarray(i,i+32768));
    return btoa(binary);
  },source);
  await fs.writeFile(`${root}/patent-with-verified-drawings.docx`,Buffer.from(encoded,'base64'));
  await fs.writeFile(`${root}/accepted-workflow.json`,JSON.stringify(source));
  console.log(JSON.stringify({exported:true,figureCount:source.cad.views.length,applicationExporter:true,output:`${root}/patent-with-verified-drawings.docx`}));
}finally{await browser.close();}
