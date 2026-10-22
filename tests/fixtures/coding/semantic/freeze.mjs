// Pre-evaluation fixture definition. This file never invokes a model or application.
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
const dir=fileURLToPath(new URL('.',import.meta.url)),prior=JSON.parse(await readFile(new URL('../labels.json',import.meta.url),'utf8'))
const save=(file,value)=>writeFile(join(dir,file),JSON.stringify(value,null,2)+'\n'),id=n=>`synthetic-coaster-${n}`,money=n=>(n/100).toFixed(2)
const merchants={finance:'ASTER AIR',personal:'HARBOR & PINE KITCHEN',person:'BLUE HERON AIR',department:'BIRCHWOOD TABLE',company:'CEDARWING AIRLINES',amazon:'Amazon',airport:'GATE 24 MARKET','retired-account':'EMBER & LOOM CREATIVE','new-mcc':'PAPER CRANE OFFICE',unknown:'JUNIPER COUNTER','retired-class':'CONCOURSE NORTH TRAVEL SHOP'}
const categories=[{name:'Office supplies & equipment',accountCode:'6100',taxCode:'Sales tax'},{name:'Airfare & business travel',accountCode:'6200',taxCode:'Sales tax'},{name:'Business meals',accountCode:'6300',taxCode:'Sales tax'},{name:'Marketing & design services (legacy)',accountCode:'6400',taxCode:'Sales tax',ledgerAccount:'legacy-account'}]
const catalog={schema:1,business:{name:'Northstar Studio',currency:'USD',timezone:'America/New_York'},departments:[{key:'sales',name:'Sales'},{key:'engineering',name:'Engineering'}],people:[{key:'sam',email:id(61001)+'@example.test',name:'Sam Rivers',department:'sales'},{key:'alex',email:id(61002)+'@example.test',name:'Alex Reed',department:'sales'},{key:'bea',email:id(61003)+'@example.test',name:'Bea Chen',department:'engineering'}],categories,dimensions:{class:{name:'Department class',kind:'class',values:[{key:'operations',name:'Operations'},{key:'sales',name:'Sales'},{key:'engineering',name:'Engineering'},{key:'legacy-events',name:'Field Events'}]},project:{name:'Project',kind:'project',values:[{key:'internal-operations',name:'Internal operations'},{key:'harborhome-launch',name:'HarborHome launch'},{key:'kestrel-prototype',name:'Kestrel prototype'},{key:'legacy-roadshow',name:'Summit roadshow'}]},account:{name:'General ledger account',kind:'account',values:[{key:'legacy-account',name:'Marketing services - legacy chart account'}]},customer:{name:'Customer',kind:'customer',values:[{key:'harborhome',name:'HarborHome'},{key:'kestrel',name:'Kestrel Labs'}]}},retireAfterHistory:[{dimension:'account',key:'legacy-account'},{dimension:'class',key:'legacy-events'}]}
const rules={schema:1,finance:[{merchant:merchants.finance,coding:{category:1,class:1,project:1},active:true}],personal:[{employee:'sam',merchant:merchants.personal,coding:{category:2,class:2,project:2},active:true}],mcc:[{mcc:'5812',category:2},{mcc:'5943',category:0}]}
const families={airfare:[['Economy airfare Boston to Chicago',1],['Seat reservation',1]],meal:[['Sandwich lunch trays',2],['Garden salad bowl',1],['Sparkling water',3]],office:[['USB-C workstation dock',1],['Legal pads pack of 6',1],['Desk cable organizer',2]],airportMeal:[['Chicken sandwich',1],['Roasted vegetable wrap',1],['Iced coffee',2]],airportOffice:[['USB-C charging cable',1],['Laptop power adapter',1]],creative:[['Campaign artwork retainer',1],['Brand illustration service',1]],unknown:[['Mixed assortment - contents not itemized',1]]}
const counts={},cases=[],charges=[],receiptLabels=[]
for(const [index,old] of prior.cases.entries()){
 const n=counts[old.kind]??0;counts[old.kind]=n+1
 let merchant=merchants[old.kind],category=old.category,cl=old.class,project=old.project,mcc=old.mcc,family=['finance','person','company'].includes(old.kind)?'airfare':['personal','department'].includes(old.kind)?'meal':old.kind==='retired-account'?'creative':old.kind==='unknown'?'unknown':'office',reference=null
 if(old.kind==='ambiguous'){
  merchant=n<6?merchants.amazon:merchants.airport;family=n%2?'meal':'office';if(n>=6)family=n%2?'airportMeal':'airportOffice'
  category=n%2?2:0;cl=null;project=null;mcc='5999'
  // Two normal business invoices contain actual work-order context. Other till receipts give no class/project evidence.
  if(n===2){reference={customer:'Kestrel Labs',project:'Kestrel prototype',department:'Engineering'};cl=2;project=2}
  if(n===9){reference={customer:'HarborHome',project:'HarborHome launch',department:'Sales'};cl=1;project=1}
 }
 if(['finance','person','company'].includes(old.kind))mcc='4511'
 if(['personal','department'].includes(old.kind))mcc='5812'
 if(old.kind==='retired-account')mcc='7311'
 if(old.kind==='retired-class')family='airportOffice'
 const receiptId=id(30000+index),date=`2026-10-${String(1+index%20).padStart(2,'0')}`
 const lines=families[family].map(([description,quantity],j)=>{const unit=family==='airfare'?(j===0?18400+n*213:2400+n*7):family==='creative'?(j===0?32500+n*170:12200+n*110):family==='unknown'?4770+n*91:family==='office'||family==='airportOffice'?(j===0?4890+n*37:1595+n*17+j*295):1095+n*23+j*310;return {description,quantity,unitPrice:money(unit),amount:money(unit*quantity)}})
 if(reference){lines[0].description+=` - ${reference.project} for ${reference.customer}`;if(lines[1])lines[1].description+=` - ${reference.department} team delivery`;}
 const subtotal=lines.reduce((sum,x)=>sum+Math.round(Number(x.amount)*100),0),tax=family==='airfare'?Math.round(subtotal*.075):Math.round(subtotal*.0625),tip=family==='meal'||family==='airportMeal'?Math.round(subtotal*.18):0,amount=money(subtotal+tax+tip)
 const label={id:receiptId,kind:old.kind,merchant,employee:'sam',date,amount,mcc,category,class:cl,project,repeat:old.repeat,receipt:`receipts/${receiptId}.png`,expectedCustomer:reference?.customer??null,readingLabel:`labels/${receiptId}.json`,intent:old.kind==='finance'?'Finance airfare rule overrides earlier bookkeeping.':old.kind==='personal'?'The employee personal meal rule overrides historical coding.':old.kind==='retired-account'?'Design services have no active mapped expense account after retirement; abstain.':old.kind==='retired-class'?'The former class is archived. The current office-goods MCC supplies only category.':old.kind==='unknown'?'The itemized contents and business purpose are unavailable; abstain rather than infer from the counter merchant.':old.kind==='ambiguous'?'This merchant sells unrelated goods; use actual line items. Dimension context exists only on the two identified ordinary invoices.':'Established human bookkeeping for this merchant supplies category, class and project.'}
 const printed={schema:1,id:receiptId,merchant,date,currency:'USD',last4:'1111',subtotal:money(subtotal),salesTax:money(tax),tip:money(tip),total:amount,lineItems:lines,reference,format:family==='airfare'?'airline-email':reference?'business-invoice':family==='meal'?'restaurant-receipt':family==='airportMeal'?'airport-cafe':old.kind==='ambiguous'&&n<6?'marketplace-invoice':family==='creative'?'service-invoice':index%3===0?'thermal-receipt':index%3===1?'retail-invoice':'photographed-receipt',expected:{category,class:cl,project,customer:reference?.customer??null}}
 cases.push(label);receiptLabels.push(printed)
 charges.push({id:receiptId,employee:'sam',last4:'1111',date,merchant,amount,mcc})
}
const map={'synthetic-coaster-1001':merchants.finance,'synthetic-coaster-1002':merchants.personal,'synthetic-coaster-1003':merchants.person,'synthetic-coaster-1004':merchants.department,'synthetic-coaster-1005':merchants.company,'synthetic-coaster-1007':merchants['retired-account'],'synthetic-coaster-1010':merchants['retired-class']}
const ambiguousHistoryCounts={}
const history=prior.history.map((row,index)=>{
 let merchant=map[row.merchant],category=row.category,cl=row.class,project=row.project
 if(row.merchant==='synthetic-coaster-1006'){
  const month=Number(row.date.slice(5,7)),which=month%2===0?'amazon':'airport';merchant=merchants[which]
  const j=ambiguousHistoryCounts[which]??0;ambiguousHistoryCounts[which]=j+1;category=j%2?2:0;cl=category===0?0:1;project=category===0?0:1
 }
 const amount=money((category===1?19400:category===2?3970:category===3?35700:3560)+index*17)
 return {id:id(40000+index),merchant,employee:row.employee,date:row.date,amount,category,class:cl,project,description:category===1?'Flight purchased for a customer visit':category===2?'Working lunch with the project team':category===3?'Design services under the former marketing account':'Supplies under the bookkeeping policy then in force'}
})
const labels={schema:2,method:'Frozen before any live evaluation. Kind composition is copied exactly from the original 120-case corpus, without optimizing toward an accuracy target. Expected business coding comes from native policy/history or visible purchased goods. The two contextual invoices carry ordinary customer/project references; all other source-five dimensions lack evidence. Unknown and retired-account cases require abstention and count in full denominators. Pixels contain no coding labels, category answers, hidden instructions or catalog IDs. Historical entries are observed earlier bookkeeping, including obsolete treatments that current exact rules override.',kindCounts:counts,historyFile:'history.json',catalogFile:'catalog.json',rulesFile:'rules.json',chargesFile:'charges.json',cases}
await mkdir(join(dir,'labels'),{recursive:true});await mkdir(join(dir,'receipts'),{recursive:true})
await Promise.all([save('catalog.json',catalog),save('rules.json',rules),save('charges.json',{schema:1,issuer:'synthetic-coaster-300',currency:'USD',rows:charges}),save('history.json',{schema:1,months:[...new Set(history.map(x=>x.date.slice(0,7)))].sort(),rows:history}),save('labels.json',labels),...receiptLabels.map(label=>save(`labels/${label.id}.json`,label))])
console.log(JSON.stringify({cases:cases.length,kindCounts:counts,history:history.length,months:new Set(history.map(x=>x.date.slice(0,7))).size}))
