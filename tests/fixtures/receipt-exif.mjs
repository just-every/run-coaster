// Genuine APP1 Exif segment inserted before the JPEG's original segments.
export function withExif(jpeg,{software='GIMP 3.0',original='2026:06:19 12:00:00',little=true}={}){
 const strings=[Buffer.from(software+'\0','ascii'),Buffer.from(original+'\0','ascii')]
 const child=38,start=56,tiff=Buffer.alloc(start+strings[0].length+strings[1].length)
 const short=(p,v)=>little?tiff.writeUInt16LE(v,p):tiff.writeUInt16BE(v,p)
 const long=(p,v)=>little?tiff.writeUInt32LE(v,p):tiff.writeUInt32BE(v,p)
 tiff.write(little?'II':'MM',0);short(2,42);long(4,8);short(8,2)
 short(10,0x0131);short(12,2);long(14,strings[0].length);long(18,start)
 short(22,0x8769);short(24,4);long(26,1);long(30,child)
 short(child,1);short(child+2,0x9003);short(child+4,2);long(child+6,strings[1].length);long(child+10,start+strings[0].length)
 strings[0].copy(tiff,start);strings[1].copy(tiff,start+strings[0].length)
 const payload=Buffer.concat([Buffer.from('Exif\0\0','ascii'),tiff]),header=Buffer.alloc(4)
 header[0]=255;header[1]=0xe1;header.writeUInt16BE(payload.length+2,2)
 return Buffer.concat([jpeg.subarray(0,2),header,payload,jpeg.subarray(2)])
}
