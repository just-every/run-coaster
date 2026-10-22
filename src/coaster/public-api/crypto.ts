const utf8=new TextEncoder();
const encode=(bytes:ArrayBuffer|Uint8Array)=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function sealingKey(secret:string) {
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',utf8.encode('coaster-public-webhook-v1\0'+secret)),'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(secret:string,id:string,value:string) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  return encode(iv)+'.'+encode(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf8.encode(id)},await sealingKey(secret),utf8.encode(value)));
}
export async function unseal(secret:string,id:string,value:string) {
  const [iv,data]=value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:utf8.encode(id)},await sealingKey(secret),decode(data)));
}
export async function signature(secret:string,timestamp:string,body:string) {
  const key=await crypto.subtle.importKey('raw',utf8.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,utf8.encode(timestamp+'.'+body)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
