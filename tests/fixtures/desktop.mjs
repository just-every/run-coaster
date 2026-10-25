import assert from 'node:assert/strict'
// Desktop itself is the sole network-edge fixture: every connector operation below reaches the production SOAP route.
const xmlEscape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const xmlDecode = s => s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&')
export async function desktopEdge(h) {
  const soap=async(method,params={})=>{
    const r=await h.mf.dispatchFetch(h.origin+'/api/coaster/accounting/desktop/soap',{method:'POST',headers:{'content-type':'text/xml'},body:`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://developer.intuit.com/">${Object.entries(params).map(([k,v])=>`<${k}>${xmlEscape(v)}</${k}>`).join('')}</${method}></soap:Body></soap:Envelope>`})
    const text=await r.text();assert.equal(r.status,200,text)
    return xmlDecode(text.match(new RegExp(`<${method}Result>([\\s\\S]*?)</${method}Result>`))[1])
  }
  const catalog={Account:['synthetic-coaster-1','synthetic-coaster-2','synthetic-coaster-3'],Class:['synthetic-coaster-4'],Customer:['synthetic-coaster-5'],Vendor:['synthetic-coaster-6'],Employee:['synthetic-coaster-7']}
  const response=(kind,id,code=0,message='',txn='synthetic-coaster-20')=>`<QBXML><QBXMLMsgsRs><${kind}Rs requestID="${id}" statusCode="${code}" statusMessage="${message}">${kind.endsWith('Query')?(catalog[kind.slice(0,-5)]??[]).map(x=>`<${kind.slice(0,-5)}Ret><ListID>${x}</ListID><Name>${x}</Name><IsActive>true</IsActive></${kind.slice(0,-5)}Ret>`).join(''):`<${kind.slice(0,-3)}Ret><TxnID>${txn}</TxnID></${kind.slice(0,-3)}Ret>`}</${kind}Rs></QBXMLMsgsRs></QBXML>`
  let ticket=''; const sent=[]
  return {soap,sent,response,get ticket(){return ticket},async open(config,password){const user=config.match(/<UserName>(.*?)<\/UserName>/)[1];const result=await soap('authenticate',{strUserName:user,strPassword:password});ticket=result.match(/<string>(.*?)<\/string>/)[1];assert.ok(ticket);return result},async drain(failKind=''){
    for(let n=0;n<60;n++) { const request=await soap('sendRequestXML',{ticket});if(!request)break;const [,kind,id]=request.match(/<(\w+)Rq requestID="([^"]+)"/);sent.push({kind,id,request});const fail=kind===failKind;const answer=response(kind,id,fail?3140:0,fail?'Account is inactive':'');await soap('receiveResponseXML',{ticket,response:answer,hresult:'',message:''}); }
    await soap('closeConnection',{ticket})
  }}
}

