#!/usr/bin/env node
// Explicit, read-only source preparation. Native import authority remains at
// Coaster's owner-only preview/commit doors; credentials never enter an import.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const endpoint = 'https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations';
const notice = 'Export selected Expensify reports and policy metadata to private local files. Send partner credentials only to Expensify. No source report is changed, marked exported or emailed.';
async function main(args) {
  const allowed = ['--consent','--reports','--policies','--template','--output'];
  const options = {};
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(!allowed.includes(flag)||Object.hasOwn(options,flag))throw Error('Use --consent --reports IDS --policies IDS --template FILE --output DIRECTORY');
    options[flag]=flag==='--consent'?true:args[++i];
  }
  if(!options['--consent'])throw Error(notice+' Repeat with --consent after reviewing it.');
  const ids = flag => {
    const text=options[flag];
    if(typeof text!=='string'||!/^[-a-zA-Z0-9_,]{1,2000}$/.test(text))throw Error('Choose explicit report and policy IDs (comma separated).');
    const entries=text.split(',');if(entries.some(id=>!id)||entries.length>100)throw Error('Choose 1–100 explicit source IDs.');return [...new Set(entries)];
  };
  const reports=ids('--reports'), policies=ids('--policies');
  if(typeof options['--template']!=='string'||typeof options['--output']!=='string')throw Error('Choose a report template and a private output directory.');
  const template=await readFile(options['--template'],'utf8');
  if(!template.trim()||Buffer.byteLength(template)>100000)throw Error('Choose an export template of at most 100 KB.');
  const credentials={partnerUserID:process.env.EXPENSIFY_PARTNER_USER_ID,partnerUserSecret:process.env.EXPENSIFY_PARTNER_USER_SECRET};
  if(!credentials.partnerUserID||!credentials.partnerUserSecret)throw Error('Supply EXPENSIFY_PARTNER_USER_ID and EXPENSIFY_PARTNER_USER_SECRET privately in the environment.');
  const request=async(job,extra={},json=false)=>{
    let response;
    try {response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({requestJobDescription:JSON.stringify({...job,credentials}),...extra})});}
    catch {throw Error('Expensify request failed; no automatic retry. No credentials were saved.');}
    if(!response.ok)throw Error(`Expensify refused the export (HTTP ${response.status}); no response body was logged.`);
    const reader=response.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2000000){await reader.cancel();throw Error('Expensify output exceeds the 2 MB file limit. Split the export.');}chunks.push(value);}
    const bytes=Buffer.concat(chunks);
    // An upstream error or echo must not place credentials in retained files.
    if(Object.values(credentials).some(value=>bytes.includes(Buffer.from(value))))throw Error('Expensify response contained credentials; nothing was retained.');
    if(!json)return bytes;
    let result;try{result=JSON.parse(bytes.toString());}catch{throw Error('Expensify returned invalid policy JSON.');}
    if(result.responseCode&&result.responseCode!==200)throw Error('Expensify refused the policy export; nothing was retained.');
    return bytes;
  };
  const file=await request({type:'file',onReceive:{immediateResponse:['returnRandomFileName']},inputSettings:{type:'combinedReportData',filters:{reportIDList:reports.join(',')}},outputSettings:{fileExtension:'csv'}},{template});
  const fileName=file.toString().trim();
  if(!/^[a-zA-Z0-9_.-]{1,200}\.csv$/.test(fileName)||fileName.includes('..'))throw Error('Expensify did not return a safe generated CSV filename. Nothing was retained.');
  const csv=await request({type:'download',fileName,fileSystem:'integrationServer'});
  if(!csv.toString().startsWith('reportID,'))throw Error('The export template must produce the documented report-template CSV. Nothing was retained.');
  const policy=await request({type:'get',inputSettings:{type:'policy',policyIDList:policies,fields:['categories','reportFields','tags','tax','employees']}}, {}, true);
  const directory=resolve(options['--output']);
  // A new directory prevents overwriting a prior export or following file links.
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'reports.csv'),csv,{mode:0o600,flag:'wx'});
  await writeFile(join(directory,'source-policy.json'),policy,{mode:0o600,flag:'wx'});
  console.log('Exported reports.csv and source-policy.json. Review and translate policy fields using IMPORTING.md, add receipt images, then use Coaster’s owner-only preview. No source reports were changed.');
}
main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
