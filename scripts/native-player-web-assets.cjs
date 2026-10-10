'use strict';
const fs=require('node:fs');
// Use the actual WatchPage glyphs, never a separate desktop icon library.
function nativePlayerWebAssets(html) {
 const mapping={back:'watch-back-btn',restart:'watch-restart',backward:'watch-skip-back',forward:'watch-skip-fwd',audio:'watch-audio-btn',subtitles:'watch-captions-btn',fullscreen:'watch-fullscreen',volume:'watch-mute',speed:'watch-speed-btn'};
 const result={};
 const read=(id)=>{
  const button=new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/button>`).exec(html)?.[1];
  if(!button)throw Error('Missing WatchPage control '+id);
  return [...button.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)].map(m=>({
   paths:[...m[2].matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(p=>p[1]),
   stroke:/fill="none"/.test(m[1]), strokeWidth:Number(/stroke-width="([^"]+)"/.exec(m[1])?.[1]||0)
  }));
 };
 for(const [name,id]of Object.entries(mapping))result[name]=read(id)[0];
 [result.play,result.pause]=read('watch-play-pause');
 if(Object.values(result).some(x=>!x?.paths?.length))throw Error('Missing WatchPage glyph');
 return result;
}
module.exports={nativePlayerWebAssets};
if(require.main===module)process.stdout.write(JSON.stringify(nativePlayerWebAssets(fs.readFileSync(process.argv[2],'utf8'))));
