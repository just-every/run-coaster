import jpeg from 'jpeg-js'
import { decode, encode } from 'fast-png'

/** Actual image transformations, with no identifying bytes consumed by a detector. */
export function photographedCopy(bytes,{quality=78,crop=5,tilt=0.008,noise=3}={}) {
 const image=decode(bytes), width=image.width-crop*2,height=image.height-crop*2,data=new Uint8Array(width*height*4)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const sx=Math.round(x+crop+tilt*(y-height/2)),sy=Math.round(y+crop),p=(y*width+x)*4
  for(let c=0;c<3;c++) {
   const channel=image.channels===1?0:c
   const value=sx<0||sx>=image.width||sy<0||sy>=image.height?255:image.data[(sy*image.width+sx)*image.channels+channel]
   data[p+c]=Math.max(0,Math.min(255,Math.round(value*0.9+10+((x*7+y*13)%7-3)*noise)))
  }
  data[p+3]=255
 }
 return Buffer.from(jpeg.encode({width,height,data},quality).data)
}
export function croppedCopy(bytes) {
 const image=decode(bytes),crop=8,width=image.width-2*crop,height=image.height-2*crop,data=new Uint8Array(width*height*image.channels)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<image.channels;c++)data[(y*width+x)*image.channels+c]=image.data[((y+crop)*image.width+x+crop)*image.channels+c]
 return Buffer.from(encode({width,height,data,channels:image.channels,depth:8}))
}

/** A deliberately damaged JPEG with visible repeated compression-block seams. */
export function compressionGridCopy(bytes) {
 const image=decode(bytes),width=image.width,height=image.height,data=new Uint8Array(width*height*4)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const p=(y*width+x)*4,shift=(Math.floor(x/8)+Math.floor(y/8))%2?70:0
  for(let c=0;c<3;c++)data[p+c]=Math.max(0,image.data[(y*width+x)*image.channels+(image.channels===1?0:c)]-shift)
  data[p+3]=255
 }
 return Buffer.from(jpeg.encode({width,height,data},95).data)
}
