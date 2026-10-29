// Installation adapter only. Keep the hashed layout provider unchanged so saved
// legacy and extended engine pins continue to produce identical outline bytes.
import {readFile,mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {installedFonts} from './fontbook-discovery.mjs';
let staging;
try{
 const registry=JSON.parse(await readFile(new URL('./personalization-local-fonts.json',import.meta.url)));
 const {found,mismatches}=await installedFonts(registry);
 staging=await mkdtemp(join(tmpdir(),'keychain-fonts-'));
 for(const [id,font] of Object.entries(registry)){
  const source=found.get(id)||mismatches.get(id);if(!source)continue;
  const target=join(staging,font.filename);await copyFile(source,target);await chmod(target,0o600);
 }
 const chunks=[];let size=0;
 if(!process.argv.includes('--catalog'))for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw Error('budget');chunks.push(chunk);}
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./personalization-provider.mjs',import.meta.url)),...process.argv.slice(2)],{
  input:Buffer.concat(chunks),encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,
  env:{...process.env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:staging},
 });
 if(result.error||result.signal||!result.stdout)throw Error('provider');
 process.stdout.write(result.stdout);process.exitCode=result.status??1;
}catch{
 process.stdout.write(JSON.stringify({ok:false,error:'local_font_discovery_failed'}));process.exitCode=1;
}finally{if(staging)await rm(staging,{recursive:true,force:true});}
