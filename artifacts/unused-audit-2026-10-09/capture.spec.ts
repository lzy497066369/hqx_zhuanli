import {test,expect,type Page,type Locator} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {mockNaming} from '../../tests/fixtures/namingAi';
import {mockStructure,generateStructure} from '../../tests/fixtures/structureFlow';
const out=path.resolve('artifacts/unused-audit-2026-10-09');
const evidence:{checks:Record<string,unknown>;requests:string[];blocked:string[];screenshots:string[]}={checks:{},requests:[],blocked:[],screenshots:[]};
const esc=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function capture(page:Page,file:string,title:string,subtitle:string,notes:string[],marks:{target:Locator;label:string;color?:string}[]=[]) {
  await page.evaluate(()=>document.fonts.ready); await page.waitForTimeout(250);
  const viewport=page.viewportSize()!;
  const boxes=[];
  for(const mark of marks){const b=await mark.target.boundingBox();if(b&&b.y<viewport.height&&b.y+b.height>0)boxes.push({...b,label:mark.label,color:mark.color||'#bb303a'});}
  const raw=await page.screenshot({path:path.join(out,file.replace('.png','-raw.png')),animations:'disabled'});
  const composite=await page.context().newPage();
  await composite.setViewportSize({width:viewport.width,height:viewport.height+360});
  await composite.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#192c39;font-family:'Microsoft YaHei','Segoe UI',sans-serif}header{padding:24px 32px 20px;background:#132e2e;color:white;border-bottom:5px solid #55bc92}h1{margin:0 0 8px;font-size:27px}header p{margin:0;font-size:16px;color:#dbe8e4}.shot{position:relative;height:${viewport.height}px;overflow:hidden}.shot img{width:100%;height:100%;display:block}.box{position:absolute;border:3px solid var(--c);border-radius:5px;box-shadow:0 0 0 2px #ffffffb5;pointer-events:none}.box span{position:absolute;left:4px;top:-15px;padding:4px 10px;background:var(--c);border-radius:4px;color:white;font-size:14px;font-weight:700}.notes{padding:24px 30px;background:white;display:grid;grid-template-columns:1fr 1fr;gap:15px 32px;border-top:1px solid #dce3e7}.notes p{margin:0;line-height:1.75;font-size:16px}.foot{padding:0 30px 20px;background:white;color:#576b74;font-size:13px}</style><header><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header><div class="shot"><img alt="项目实际页面截图" src="data:image/png;base64,${raw.toString('base64')}">${boxes.map(b=>`<div class="box" style="--c:${b.color};left:${Math.max(b.x-3,0)}px;top:${Math.max(b.y-3,0)}px;width:${Math.min(b.width+6,viewport.width-b.x)}px;height:${Math.min(b.height+6,viewport.height-Math.max(b.y-3,0))}px"><span>${esc(b.label)}</span></div>`).join('')}</div><div class="notes">${notes.map(n=>`<p>${esc(n)}</p>`).join('')}</div><div class="foot">知创工坊 · 2026-10-09 代码审计｜截图为隔离浏览器中的演示数据，不包含用户已有项目；高亮与说明是审计标注。</div></html>`);
  await composite.evaluate(()=>document.fonts.ready);
  const height=await composite.locator('body').evaluate(el=>Math.ceil(el.getBoundingClientRect().height));
  await composite.screenshot({path:path.join(out,file),clip:{x:0,y:0,width:viewport.width,height},animations:'disabled'});
  await composite.close(); evidence.screenshots.push(file);
}
test('真实页面定位、孤立组件预览与当前调用链核对',async({page})=>{
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/'))evidence.requests.push(`${r.method()} ${url.pathname}`);});
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.protocol==='data:'||u.protocol==='blob:')return route.continue();
    if(u.origin!=='http://127.0.0.1:5187'){evidence.blocked.push(u.origin+u.pathname);return route.abort();}
    // Only the offline structure compiler can reach the local backend.
    if(u.pathname.startsWith('/api/')&&u.pathname!=='/api/utility/compile-structure'){
      evidence.blocked.push(u.pathname);return route.fulfill({status:503,json:{error:{message:'Audit: unmocked AI call blocked'}}});
    }
    return route.continue();
  });
  await page.clock.setFixedTime(new Date('2026-10-09T10:00:00+08:00'));
  await page.goto('/');
  await expect(page.locator('.category-card')).toHaveCount(4);
  await capture(page,'01-frontend-entry-map.png','前端位置总览：入口在用，闲置代码在入口之后','绿框标出当前入口；它们不是无效按钮。真正未接入的组件、旧函数与资源见下方对应编号。',[
    'F1 发明专利：当前路由复用 UtilityNaming / UtilityWorkspace；旧 InventionWorkspace 和专属 CSS 没有入口。',
    'F2 实用新型：取名界面走后端 API，旧 naming.ts 中的 generateNames / productCore / RULE_VERSION 无调用。',
    'F3 模板中心：按钮创建项目，不读取 public/templates/utility-standard.docx；该历史模板未参与当前导出。',
    '补充：资料库是会话内文件信息预览，不上传内容；这是明确的功能边界，不是死代码。'
  ],[
    {target:page.locator('.category-card').filter({has:page.getByRole('heading',{name:'发明专利',exact:true})}),label:'F1 发明入口（在用）',color:'#167750'},
    {target:page.locator('.category-card').filter({has:page.getByRole('heading',{name:'实用新型',exact:true})}),label:'F2 实用新型入口（在用）',color:'#167750'},
    {target:page.locator('aside a[href="#templates"]'),label:'F3',color:'#167750'},
  ]);
  await page.locator('.category-card').filter({has:page.getByRole('heading',{name:'发明专利',exact:true})}).getByRole('button',{name:'开始创作'}).click();
  await expect(page.locator('.utility-naming[data-patent-type="invention"]')).toBeVisible();
  await expect(page.locator('.invention-workspace')).toHaveCount(0);
  const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>e.name));
  evidence.checks.currentInventionUsesUtilityNaming=true;
  evidence.checks.orphanComponentNotRequested=resources.every(s=>!s.includes('/features/invention/InventionWorkspace')&&!s.includes('/features/invention/invention.css'));
  await capture(page,'02-current-invention.png','F1 · 当前发明专利入口实际显示的页面','真实主应用：/#invention/<id> → UtilityNaming；确认名称后 → UtilityWorkspace（patentType="invention"）。',[
    '这个四步条与取名表单属于 UtilityNaming，不是旧 InventionWorkspace。不要把当前页面删掉。',
    '旧组件完全没有前端导航位置。下一张图仅隔离渲染旧源码，以便识别它原本的外观。'
  ],[{target:page.locator('.un-steps'),label:'在用',color:'#167750'}]);
  await page.goto('/artifacts/unused-audit-2026-10-09/orphan-invention.html');
  await expect(page.locator('.invention-workspace')).toBeVisible();
  await capture(page,'03-orphan-invention.png','F1 · 没有接入主应用的旧发明工作区','旧源码独立渲染，不是当前网站可访问的业务页面；仅为本次审计添加了隔离预览入口。',[
    '无调用组件：src/features/invention/InventionWorkspace.tsx:27；与上图现行流程不同。',
    '连带闲置：invention.css 整份样式；makeInventionMaterials 只有旧组件与测试引用。'
  ],[{target:page.locator('.invention-workflow'),label:'F1 闲置'}]);
  await page.goto('/#utility');
  await mockNaming(page,'光伏组件安装支架');
  await page.getByLabel('企业名称',{exact:false}).fill('审计演示科技有限公司');
  await page.getByLabel('产品名称',{exact:false}).fill('光伏组件安装支架');
  await page.getByRole('button',{name:'生成产品建议'}).click();
  await page.getByRole('button',{name:'光伏组件安装支架',exact:true}).click();
  await page.getByLabel('H型截面').check();
  await page.getByRole('radio',{name:'构造改进'}).check();
  await page.getByRole('button',{name:'生成结构资料选项'}).click();
  for(const label of ['壳体与支架','固定连接','部件相对固定','平板与方壳'])await page.getByRole('checkbox',{name:new RegExp(label)}).check();
  await page.getByRole('button',{name:'确认所选结构资料'}).click();
  const namesButton=page.getByRole('button',{name:'确认选项并生成名称'});
  await namesButton.scrollIntoViewIfNeeded();
  await capture(page,'04-naming-location.png','F2 · 取名按钮的位置与被闲置的旧取名器','当前按钮有真实调用：UtilityNaming 内部 generateNames → POST /api/utility/naming-names。',[
    '未调用的是 naming.ts:364 导出的旧 generateNames，不是此按钮绑定的同名局部函数。',
    '同组无引用：naming.ts:69 productCore、:42 RULE_VERSION；directions / materialCores 仅服务于旧函数。',
    '截图中的产品与结构选项来自项目现有测试夹具；未向外部 AI 服务发送数据。'
  ],[{target:namesButton,label:'F2 在用',color:'#167750'}]);
  await namesButton.click();
  await page.locator('.un-candidate').first().click();
  await page.getByRole('checkbox',{name:/我已确认名称/}).check();
  await page.getByRole('button',{name:'确认名称并保存'}).click();
  await page.getByRole('button',{name:'进入结构与材料工作区'}).click();
  const close=page.getByRole('button',{name:'关闭提示',exact:true});if(await close.isVisible())await close.click();
  await mockStructure(page);
  await generateStructure(page);
  await page.locator('.uw-tabs').evaluate(el=>{el.scrollIntoView({block:'start'});window.scrollBy(0,-24);});
  const notice=page.getByRole('button',{name:'关闭提示',exact:true});if(await notice.isVisible())await notice.click();
  await capture(page,'05-drawing-location.png','F4 · 绘图与结构区域：旧辅助函数和样式已经脱离现行流程','实际页面仍在正常渲染；这不是把“绘图与部件”整块判为未使用。',[
    '零调用辅助导出：isPlanResponse、GEOMETRY_EXAMPLE、contains、alignFigureSpecsToRenderedModel、emptyStructureDraft。',
    '无对应 DOM 的旧样式：.uw-model-controls（旧模型控件）、.uw-copy-panel（旧文案编辑面板）。',
    '另有旧构造器与材料生成器仅在测试/旧链路中使用，详见报告，不能作为“全仓零调用”删除。',
    '当前图示由测试夹具 + 本地离线编译生成；没有调用外部模型或检索服务。'
  ],[{target:page.locator('.uw-drawing-panel'),label:'F4 在用',color:'#167750'}]);
  evidence.checks.orphanCssClassesAbsent=await page.locator('.uw-copy-panel,.uw-model-controls').count()===0;
  await page.getByRole('tab',{name:'申请材料',exact:true}).click();
  await page.locator('.uw-materials-panel').scrollIntoViewIfNeeded();
  await capture(page,'06-materials-location.png','F5 · 申请材料：现行 V2 入口和未使用的历史模板','当前“重新生成文案”走 materials-v2；Word 由 docx 库编程生成，不加载历史 utility-standard.docx。',[
    'src/data.ts:254 makeUtilityMaterials 仅测试调用；旧材料链与现行 V2 请求必须分开处理。',
    'public/templates/utility-standard.docx 没有应用引用；模板中心的按钮也不读取它。',
    'server/materialsV2Api.ts:179 的 Express 注册器没有调用，但 :376 的 handleMaterialsV2Request 正在被调用。',
    '此截图仅展示材料区入口，没有发起生成文案或实际 AI 请求。'
  ],[{target:page.locator('.uw-materials-panel'),label:'F5 在用',color:'#167750'}]);
  evidence.checks.noPageErrors=errors.length===0;evidence.checks.pageErrors=errors;
  expect(errors).toEqual([]);
  expect(evidence.blocked).toEqual([]);
  fs.writeFileSync(path.join(out,'browser-evidence.json'),JSON.stringify(evidence,null,2));
});
