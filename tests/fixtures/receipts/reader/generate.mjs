// Deterministic synthetic receipt pixels and labels. Labels are never supplied to the application or provider.
import { chromium } from '@playwright/test'
import { PDFDocument,StandardFonts,rgb } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import { writeFile,readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const dir=fileURLToPath(new URL('.',import.meta.url)),money=n=>(n/100).toFixed(2),escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;')
const browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
try {
 const page=await browser.newPage({viewport:{width:820,height:1120},deviceScaleFactor:1}),manifest=[]
 for(let i=1;i<=40;i++) {
  const id=`synthetic-coaster-${1000+i}`,kind=i<=6?'restaurant':i<=10?'thermal':i<=15?'hotel':i<=20?'airline-email':i<=25?'ride-email':i<=30?'crumpled-skewed':i<=35?'invoice':'foreign',currency=kind==='foreign'?['EUR','CAD','GBP','AUD','USD'][i-36]:'USD'
  const merchant={restaurant:'SYNTHETIC COASTER CAFE',thermal:'SYNTHETIC COASTER MARKET',hotel:'SYNTHETIC COASTER HOTEL','airline-email':'SYNTHETIC COASTER AIR','ride-email':'SYNTHETIC COASTER RIDES','crumpled-skewed':'SYNTHETIC COASTER SUPPLY',invoice:'SYNTHETIC COASTER PRINT',foreign:'SYNTHETIC COASTER BISTRO'}[kind]
  const date=`2026-08-${String((i-1)%28+1).padStart(2,'0')}`,names=kind==='hotel'?['Room night 1','Room night 2','Room night 3']:kind==='airline-email'?['Passenger fare','Seat selection','Checked bag']:kind==='ride-email'?['Trip fare','Booking fee']:kind==='invoice'?['Printed booklets','Binding service','Delivery']:kind==='restaurant'||kind==='foreign'?['Grilled sandwich','Garden salad','Iced tea']:['Office paper','Pens','Folder']
  const lineItems=names.map((description,j)=>({description,quantity:1,amount:money(kind==='hotel'?12000+i*10+j*100:1200+i*13+j*335)})),subtotal=lineItems.reduce((n,x)=>n+Math.round(Number(x.amount)*100),0),tax=Math.round(subtotal*.075),tip=['restaurant','foreign'].includes(kind)?Math.round(subtotal*.18):0,total=subtotal+tax+tip,last4=String(3100+i)
  const values={merchant,date,total:money(total),subtotal:money(subtotal),salesTax:money(tax),tip:money(tip),currency,last4,lineItems},handwritten=i===1,faded=i===7,skew=kind==='crumpled-skewed'?(i%2?2.5:-2.5):0
  const header=kind.endsWith('email')?`<div class="email">From: receipts@${id}.example<br>To: employee@synthetic-coaster-1.example<br>Subject: Your ${kind==='ride-email'?'trip':'flight'} receipt</div>`:''
  const receipt=`${header}<main class="receipt"><h1 data-field="merchant">${merchant}</h1><p>${kind==='hotel'?'FINAL GUEST FOLIO':kind==='invoice'?'PAID INVOICE':'PURCHASE RECEIPT'}</p><p>Boston, MA 02110 · Synthetic US business</p><p>Receipt ${id}</p><p>Date: <span data-field="date">${date}</span></p><p>Currency: <span data-field="currency">${currency}</span></p><hr><section data-field="lineItems">${lineItems.map(x=>`<div class="row"><span>${x.description} × 1</span><b>${x.amount}</b></div>`).join('')}</section><hr>${[['Subtotal','subtotal'],['Sales tax','salesTax'],['Tip','tip'],[kind==='hotel'?'FOLIO TOTAL':'TOTAL','total']].map(([label,key])=>`<div class="row ${key==='total'?'grand':''} ${key==='tip'&&handwritten?'handwritten':''}"><span>${label}</span><b data-field="${key}">${values[key]}</b></div>`).join('')}<p>PAID BY CARD ending <span data-field="last4">${last4}</span></p><p>Payment received. Keep this receipt.</p></main>`
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:55px;background:#d8d9d6;font:20px ${kind==='thermal'?'monospace':'Arial,sans-serif'};color:${faded?'#72726d':'#171a1a'}}main{width:690px;min-height:900px;background:#fffdf5;padding:44px;box-shadow:3px 5px 10px #999;transform:rotate(${skew}deg);${kind==='crumpled-skewed'?'background-image:repeating-linear-gradient(165deg,transparent 0px,#00000006 40px,transparent 44px,transparent 90px);':''}}h1{font-size:27px;margin-top:0;line-height:1.3}p{line-height:1.5;font-size:18px}.row{display:flex;justify-content:space-between;gap:25px;margin:22px 0}.grand{font-size:28px;border-top:2px solid;padding-top:22px}.handwritten{font-family:Comic Sans MS,cursive;font-style:italic;transform:rotate(-2deg)}.email{font:14px Arial;background:#fff;padding:12px;margin-bottom:12px}hr{border:0;border-top:1px dashed #777}</style>${receipt}`)
  await page.screenshot({path:join(dir,id+'.png')})
  const regions=await page.locator('[data-field]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>{const r=n.getBoundingClientRect();return [n.dataset.field,[{page:1,x:r.x/820,y:r.y/1120,width:r.width/820,height:r.height/1120}]]})))
  const label={id,file:id+'.png',kind,tags:[kind,...(handwritten?['handwritten-tip']:[]),...(faded?['faded-thermal']:[])],values,regions}
  await writeFile(join(dir,id+'.json'),JSON.stringify(label,null,2)+'\n');manifest.push({id,file:label.file,label:id+'.json'})
  if(kind==='invoice') {
   const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Courier),bold=await pdf.embedFont(StandardFonts.CourierBold)
   const pages=[pdf.addPage([612,792]),pdf.addPage([612,792])]
   const text=(p,s,y,size=14,strong=false)=>p.drawText(s,{x:48,y,size,font:strong?bold:font,color:rgb(.08,.08,.08)})
   for(const [n,p] of pages.entries()){text(p,merchant,740,18,true);text(p,`PAID INVOICE ${id} - Page ${n+1} of 2`,710);text(p,`Date: ${date}    Currency: ${currency}`,680)}
   lineItems.slice(0,2).forEach((x,j)=>text(pages[0],`${x.description} x1    ${x.amount}`,610-j*35));text(pages[0],'Continued on page 2 - not the final total',480)
   text(pages[1],`${lineItems[2].description} x1    ${lineItems[2].amount}`,610)
   for(const [n,[k,v]] of Object.entries({Subtotal:values.subtotal,'Sales tax':values.salesTax,Tip:values.tip,TOTAL:values.total}).entries())text(pages[1],`${k}: ${v}`,540-n*35,k==='TOTAL'?20:14,k==='TOTAL')
   text(pages[1],`PAID BY CARD ending ${last4}`,340)
   const pdfId=`synthetic-coaster-${2000+i}`,pdfLabel={...label,id:pdfId,file:pdfId+'.pdf',kind:'multipage-pdf',tags:['multipage-pdf','invoice'],regions:{}}
   await writeFile(join(dir,pdfId+'.pdf'),await pdf.save());await writeFile(join(dir,pdfId+'.json'),JSON.stringify(pdfLabel,null,2)+'\n');manifest.push({id:pdfId,file:pdfLabel.file,label:pdfId+'.json'})
  }
 }
 execFileSync('/usr/bin/sips',['-s','format','heic',join(dir,'synthetic-coaster-1002.png'),'--out',join(dir,'synthetic-coaster-2041.heic')],{stdio:'pipe'})
 const heicLabel={...JSON.parse(await readFile(join(dir,'synthetic-coaster-1002.json'),'utf8')),id:'synthetic-coaster-2041',file:'synthetic-coaster-2041.heic',kind:'heic',tags:['heic','restaurant','printed-tip']}
 await writeFile(join(dir,heicLabel.id+'.json'),JSON.stringify(heicLabel,null,2)+'\n');manifest.push({id:heicLabel.id,file:heicLabel.file,label:heicLabel.id+'.json'})
 await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,synthetic:true,receipts:manifest},null,2)+'\n')
 console.log(`Generated ${manifest.length} labeled synthetic receipt originals (40 PNG images, 5 multipage PDFs, 1 HEIC image)`)
} finally {await browser.close()}
