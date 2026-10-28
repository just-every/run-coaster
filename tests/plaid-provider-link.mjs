import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { join } from 'node:path';

/** Complete the real provider-hosted Sandbox login, then require the native exchange and visible connection. */
export async function hostedPlaidLink({h,browser,attach,scope,cookie,width=1440,folder}) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  let page;
  try {
    await attach(context,{...h,owner:cookie});
    await context.route(/^https:\/\/([a-zA-Z0-9-]+\.)*plaid\.com\//,route=>route.continue());
    page=await context.newPage();await page.goto(h.origin+'/app#/settings');
    const section=page.getByRole('region',{name:'Plaid transaction feeds',exact:true});
    await section.getByText('Connect a transaction feed',{exact:true}).click();
    await section.getByLabel('Feed scope',{exact:true}).selectOption(scope);
    await section.getByRole('checkbox',{name:/I authorize sharing selected accounts/}).check();
    await section.getByRole('button',{name:'Open Plaid Link',exact:true}).click();
    const frame=page.frameLocator('iframe[title="Plaid Link"]');
    await frame.getByRole('button',{name:'Continue without phone number',exact:true}).click({timeout:60_000});
    await frame.getByText('Select your institution',{exact:true}).waitFor({state:'visible',timeout:60_000});
    await frame.getByPlaceholder('Search',{exact:true}).fill('First Platypus Bank');
    await frame.getByText('First Platypus Bank',{exact:true}).click({timeout:60_000});
    await frame.getByText('3 associated institutions',{exact:true}).waitFor({state:'visible',timeout:60_000});
    await frame.getByText('First Platypus Bank',{exact:true}).last().click();
    await frame.getByLabel('Username',{exact:true}).fill('user_transactions_dynamic');
    await frame.getByLabel('Password',{exact:true}).fill('pass_good');
    if(folder)await page.screenshot({path:join(folder,`${width}-${scope}-provider.png`),fullPage:false});
    await frame.getByRole('button',{name:'Submit',exact:true}).click();
    await frame.getByText('Your accounts',{exact:true}).waitFor({state:'visible',timeout:60_000});
    const exchanged=page.waitForResponse(reply=>reply.url()===h.origin+'/api/coaster/plaid/exchange'&&reply.request().method()==='POST',{timeout:60_000});
    await frame.getByRole('button',{name:'Continue',exact:true}).click();
    const response=await exchanged;assert.equal(response.status(),200,'The actual provider Link callback crosses the native exchange');
    const connection=await response.json();assert.equal(connection.scope,scope);
    await expect(section.getByText(/Plaid feed connected:/)).toBeVisible({timeout:60_000});
    assert.ok(connection.accounts.length>0&&connection.accounts.some(account=>account.type==='credit'));
    if(scope==='personal')assert.ok(connection.accounts.every(account=>account.type==='credit'));
    const visible=(await h.get('plaid/connections',cookie)).connections.find(row=>row.id===connection.id);assert.ok(visible);
    assert.deepEqual(visible.accounts,connection.accounts);
    if(folder)await section.screenshot({path:join(folder,`${width}-${scope}-connected.png`)});
    return connection;
  } catch(error){if(folder&&page)await page.screenshot({path:join(folder,`${width}-${scope}-failed.png`),fullPage:false}).catch(()=>{});throw error;}
  finally {await context.close();}
}
