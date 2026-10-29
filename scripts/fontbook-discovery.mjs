// Local installation discovery, independent of the frozen outline engine.
import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function fontDirectories(env=process.env,home=homedir()){
 return Object.hasOwn(env,'KEYCHAIN_PERSONALIZATION_FONTS_DIR')?[env.KEYCHAIN_PERSONALIZATION_FONTS_DIR]:[join(home,'Library/Fonts'),'/Library/Fonts'];
}
export async function installedFonts(registry,roots=fontDirectories()){
 const found=new Map(),mismatches=new Map();let remaining=2048,bytesRemaining=64*1024*1024;
 // Only known local font locations (or the operator override), bounded depth/count.
 // Names never determine identity: exact SHA-256 pins do, before any font parsing.
 async function scan(directory,depth=0){
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{return;}
  for(const entry of entries.sort((a,b)=>Number(/lemon/i.test(b.name))-Number(/lemon/i.test(a.name))||a.name.localeCompare(b.name,'en'))){
   if(--remaining<0)return;
   const path=join(directory,entry.name);
   if(entry.isDirectory()){if(depth<3)await scan(path,depth+1);continue;}
   if(!/\.(otf|ttf)$/i.test(entry.name))continue;
   try{
    const info=await stat(path);if(!info.isFile()||info.size>8*1024*1024||info.size>bytesRemaining)continue;
    bytesRemaining-=info.size;
    const digest=hash(await readFile(path));
    for(const [id,font] of Object.entries(registry)){
     if(digest===font.sha256&&!found.has(id))found.set(id,path);
     else if(entry.name===font.filename&&!mismatches.has(id))mismatches.set(id,path);
    }
   }catch{/* An unreadable installed file cannot be used. Other pinned copies may exist. */}
  }
 }
 for(const root of roots)if(root)await scan(root);
 return {found,mismatches};
}
