import { chromium } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fresh, command, freePort, start } from '../browser-runtime.mjs'
import { session, setUp } from '../browser-journey.mjs'
import { policyAgentScreens, policyReviewArchive } from '../browser-policy-review.mjs'

export async function runPolicyAgentJourney(){
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/policy-agent-proof')
  await mkdir(evidence,{recursive:true})
  let root,server,browser
  try{
    root=await fresh();const port=await freePort()
    await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port)])
    server=await start(root,port)
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']})
    const owner=await session(browser,root,server.origin,'owner',1440)
    await setUp(owner,server.origin);await owner.context.close()
    await policyAgentScreens(browser,root,server,evidence)
    await browser.close();browser=undefined;await server.close();server=undefined
    await policyReviewArchive(root)
  }finally{
    await browser?.close();await server?.close()
    if(root)await rm(root,{recursive:true,force:true})
  }
}
