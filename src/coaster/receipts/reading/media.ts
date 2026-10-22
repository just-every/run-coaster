import { PDFDocument } from 'pdf-lib';
import { encode } from 'fast-png';
import { requireThat } from '../../types';
export function base64(bytes:Uint8Array) {let text='';for(let n=0;n<bytes.length;n+=8192)text+=String.fromCharCode(...bytes.subarray(n,n+8192));return btoa(text);}
export async function receiptInput(bytes:Uint8Array,media:string) {
  if(media==='application/pdf') {
    let pdf:PDFDocument;try{pdf=await PDFDocument.load(bytes);}catch{requireThat(false,'This PDF is encrypted or unreadable; choose a readable original',422);}
    const pages=pdf.getPageCount();requireThat(pages>0&&pages<=20,'Read PDFs with 1 to 20 pages',422);
    return {pages,content:[{type:'input_file',detail:'high',filename:'receipt.pdf',file_data:'data:application/pdf;base64,'+base64(bytes)}]};
  }
  if(media==='image/heic') {
    const {default:heif}=await import('libheif-js'),images=new heif.HeifDecoder().decode(bytes);
    requireThat(images.length>0&&images.length<=20,'Read HEIC originals with 1 to 20 images',422);
    const content=[];
    for(const image of images){const width=image.get_width(),height=image.get_height();requireThat(width*height<=24000000,'This HEIC image exceeds the 24-megapixel reading limit',422);
      const rgba=await new Promise<{data:Uint8ClampedArray}>((resolve,reject)=>image.display({width,height,data:new Uint8ClampedArray(width*height*4)},result=>result?resolve({data:new Uint8ClampedArray(result.data)}):reject(new Error('image decode failed'))));
      content.push({type:'input_image',detail:'high',image_url:'data:image/png;base64,'+base64(encode({width,height,data:new Uint8Array(rgba.data),channels:4,depth:8}))});
    }
    return {pages:content.length,content};
  }
  requireThat(['image/jpeg','image/png','image/webp'].includes(media),'This receipt format cannot be read',422);
  return {pages:1,content:[{type:'input_image',detail:'high',image_url:`data:${media};base64,${base64(bytes)}`}]};
}
