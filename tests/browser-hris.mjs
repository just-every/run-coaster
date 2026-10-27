import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {harness} from './harness.mjs';
import {hrisFixture,hrisRoot} from './hris-kit.mjs';
import {payrollBrowserRuntime,noOverflow,tooltipProof} from './payroll-browser-runtime.mjs';
const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/hris-proof');
await mkdir(evidence,{recursive:true});
const attach=await payrollBrowserRuntime();
const browser=await chromium.launch({headless:true,...(process.env.COASTER_CHROMIUM?{executablePath:process.env.COASTER_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
try{
  // Assertions run at one desktop width; the phone pass records the same changed states and checks fit and tooltips.
  for(const width of (process.env.COASTER_PROOF_WIDTHS??'1440').split(',').map(Number)){
    const edge=hrisFixture(),h=await harness({gustoEdge:r=>edge.fetch(r)});
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
    try{
      await h.post(['settings', 'business'].join('/'),{name:'Harbour and Finch',currency:'USD',timezone:'UTC'});
      await h.person(edge.employees[0].email,{employee:true,manager:true});
      await attach(context,h);
      const page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(h.origin+'/app#/settings');
      const panel=page.getByRole('region',{name:'Gusto HRIS roster'});
      const capture=async name=>{await panel.scrollIntoViewIfNeeded();await noOverflow(page);await panel.screenshot({path:join(evidence,`${width}-${name}.png`)});};
      const submit=async(label,suffix)=>{
        const pending=page.waitForResponse(r=>r.url()===h.origin+'/api/coaster/'+hrisRoot+suffix&&r.request().method()==='POST');
        await panel.getByRole('button',{name:label,exact:true}).click();
        const response=await pending;assert.equal(response.status(),200,await response.text());
      };
      const refresh=async()=>{await panel.getByRole('button',{name:'Review HRIS roster',exact:true}).click();await expect(panel.getByRole('button',{name:'Sync Alex Hire',exact:true})).toBeVisible();};
      await expect(panel.getByLabel('HRIS company UUID')).toBeVisible();
      await capture('connect');
      await panel.getByLabel('HRIS company UUID').fill(edge.company);
      await panel.getByLabel('HRIS access token').fill('synthetic-coaster-810');
      await panel.getByRole('checkbox',{name:/I authorize reading this sandbox/}).check();
      await submit('Connect HRIS sandbox','/connect');
      await refresh();
      await panel.getByRole('checkbox',{name:'I confirmed the identity and change for Riley Manager',exact:true}).check();
      await submit('Sync Riley Manager','/sync');
      await panel.getByRole('checkbox',{name:'I confirmed the identity and change for Alex Hire',exact:true}).check();
      await submit('Sync Alex Hire','/sync');
      await expect(panel.getByRole('status')).toContainText('Roster change saved');
      if(width===1440){
        const member=await h.db.prepare('SELECT active,approver_email,is_finance FROM c_members WHERE email=?').bind(edge.employees[1].email).first();
        assert.deepEqual(member,{active:1,approver_email:edge.employees[0].email,is_finance:0});
      }
      await capture('hire');
      edge.employees[1].manager_uuid=null;
      const changed=page.waitForResponse(r=>r.url().endsWith('/'+hrisRoot+'/preview'));
      await panel.getByRole('button',{name:'Review HRIS roster',exact:true}).click();await changed;
      await submit('Sync Alex Hire','/sync');
      if(width===1440)assert.equal((await h.db.prepare('SELECT approver_email FROM c_members WHERE email=?').bind(edge.employees[1].email).first()).approver_email,null);
      await capture('manager-change');
      edge.employees[1].terminated=true;
      const terminated=page.waitForResponse(r=>r.url().endsWith('/'+hrisRoot+'/preview'));
      await panel.getByRole('button',{name:'Review HRIS roster',exact:true}).click();await terminated;
      await expect(panel.getByRole('heading',{name:'Alex Hire · Terminated',exact:true})).toBeVisible();
      await panel.getByLabel('Successor for Alex Hire',{exact:true}).selectOption(edge.employees[0].email);
      await submit('Sync Alex Hire','/sync');
      if(width===1440)assert.equal((await h.db.prepare('SELECT active FROM c_members WHERE email=?').bind(edge.employees[1].email).first()).active,0);
      await capture('terminated');
      const account=page.locator('.account-menu summary');
      if(width<1024)await tooltipProof(page,account);
      await panel.getByLabel('Disconnect this HRIS company').check();
      await submit('Disconnect HRIS','/disconnect');
      await expect(panel.getByRole('button',{name:'Connect HRIS sandbox',exact:true})).toBeVisible();
      assert.deepEqual(errors,[]);
      console.log(`HRIS screen proof passed at ${width}px`);
    }finally{await context.close();await h.close();}
  }
}finally{await browser.close();}
