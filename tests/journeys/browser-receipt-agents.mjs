// Provider costs and confirmed receipt questions share the native reading door.
import { chromium } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fresh, command, freePort, start } from '../browser-runtime.mjs'
import { session, setUp } from '../browser-journey.mjs'
import { readingEdge, costScreens, questionScreens, receiptAgentArchive } from './screens-reading.mjs'

export async function runReceiptAgentJourney(){
  const evidence=resolve(process.env.COASTER_EVIDENCE??'.cache/receipt-agent-proof')
  await mkdir(evidence,{recursive:true})
  let root,server,browser,edge
  try{
    root=await fresh();edge=await readingEdge()
    await mkdir(join(root,'.cache'),{recursive:true})
    await writeFile(join(root,'.cache/reading-answers.json'),JSON.stringify({AI_ENABLED:'true',AI_API_KEY:'synthetic-coaster-6000',AI_BASE_URL:edge.url}),{mode:0o600})
    const port=await freePort()
    await command(root,['setup','--owner-email','owner@harbourfinch.example','--port',String(port),'--answers','.cache/reading-answers.json'])
    server=await start(root,port,{readingEdge:edge})
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']})
    const owner=await session(browser,root,server.origin,'owner',1440)
    await setUp(owner,server.origin);await owner.context.close()
    await costScreens(browser,root,server.origin,evidence,edge)
    await questionScreens(browser,root,server.origin,evidence,edge)
    await browser.close();browser=undefined;await server.close();server=undefined
    await receiptAgentArchive(root,evidence)
  }finally{
    await browser?.close();await server?.close();await edge?.close()
    if(root)await rm(root,{recursive:true,force:true})
  }
}
