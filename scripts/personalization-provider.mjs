// Extended local catalog. The original v2 provider remains byte-for-byte frozen
// so existing master/variant engine pins retain exactly their old behavior.
import {readFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseFont,flattenContour} from '../js/layout.js';
import {layoutPersonalization,contourBounds,PersonalizationError} from '../js/personalization.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new PersonalizationError(code);};
const legacy=new URL('./personalization-region.mjs',import.meta.url);
function legacyCall(input){
  const r=spawnSync(process.execPath,[fileURLToPath(legacy),...(input===undefined?['--catalog']:[])],{input,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024});
  if(r.error||r.signal||!r.stdout)fail('legacy_provider_unavailable');
  return {raw:r.stdout,status:r.status,value:JSON.parse(r.stdout)};
}
const labels={bangers:'Bangers',bungee:'Bungee','lilita-one':'Lilita One','luckiest-guy':'Luckiest Guy','titan-one':'Titan One'};
try{
  const old=legacyCall();if(old.status||old.value.version!==2)fail('legacy_provider_unavailable');
  const registryBytes=await readFile(new URL('./personalization-local-fonts.json',import.meta.url));
  const registry=JSON.parse(registryBytes);
  const engine=sha(JSON.stringify({version:1,legacy:old.value.engine_sha256,adapter:sha(await readFile(new URL(import.meta.url))),registry:sha(registryBytes)}));
  // Operator-only directory; never taken from a customer request. No font binary
  // is served, embedded in this repository, or replaced by a similar font.
  const directory=process.env.KEYCHAIN_PERSONALIZATION_FONTS_DIR||join(homedir(),'Library','Fonts');
  const local={},unavailable=[];
  for(const [id,entry] of Object.entries(registry)){
    try{
      const path=join(directory,entry.filename),info=await stat(path);
      if(!info.isFile()||info.size>8*1024*1024)fail('font_unavailable');
      const bytes=await readFile(path);if(sha(bytes)!==entry.sha256)fail('font_revision_mismatch');
      local[id]={entry,bytes};
    }catch(e){unavailable.push({id,label:entry.label,error:e instanceof PersonalizationError?e.code:'font_unavailable'});}
  }
  const fonts=[...old.value.fonts.map(f=>({...f,label:labels[f.id]||f.id,supported_engine_sha256:[old.value.engine_sha256,engine]})),
    ...Object.entries(local).map(([id,{entry}])=>({id,label:entry.label,sha256:entry.sha256,supported_engine_sha256:[engine]}))];
  if(process.argv.length===3&&process.argv[2]==='--catalog'){
    process.stdout.write(JSON.stringify({version:2,engine_sha256:engine,supported_engine_sha256:[old.value.engine_sha256,engine],default_font_id:'lemon-milk',fonts,unavailable_fonts:unavailable}));
  }else{
    if(process.argv.length!==2)fail('invalid_arguments');
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)fail('request_budget');chunks.push(chunk);}
    const raw=Buffer.concat(chunks);const r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    if(!r||Array.isArray(r)||r.version!==2)fail('unsupported_version');
    // Existing pins bypass all extended behavior and retain identical JSON/hash.
    if(r.engine_sha256===old.value.engine_sha256){const out=legacyCall(raw);process.stdout.write(out.raw);process.exitCode=out.status;}
    else{
      if(r.engine_sha256!==engine)fail('engine_revision_mismatch');
      let result;
      if(old.value.fonts.some(f=>f.id===r.font_id)){
        const out=legacyCall(JSON.stringify({...r,engine_sha256:old.value.engine_sha256}));
        if(!out.value.ok)fail(out.value.error);result=out.value.result;
      }else{
        const selected=local[r.font_id];if(!selected)fail(unavailable.find(f=>f.id===r.font_id)?.error||'font_unavailable');
        if(r.font_sha256!==selected.entry.sha256)fail('font_revision_mismatch');
        const {minimum_stroke_mm,minimum_ink_height_mm,engine_sha256:ignored,...layout}=r;
        for(const n of [minimum_stroke_mm,minimum_ink_height_mm])if(typeof n!=='number'||!Number.isFinite(n)||n<=0||n>100)fail('invalid_printability');
        const b=selected.bytes,font=parseFont(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
        result=layoutPersonalization(font,{...layout,version:1});
        globalThis.self=globalThis;
        if(!globalThis.navigator)Object.defineProperty(globalThis,'navigator',{value:{userAgent:'chrome',appName:'Netscape'}});
        const {thinAndGaps}=await import('../js/print.js');
        const {toPath,unionTree,treeToPolys,polyArea}=await import('../js/clip.js');
        if([...new Set(result.contours.map(c=>c.line))].some(line=>contourBounds(result.contours.filter(c=>c.line===line)).h<minimum_ink_height_mm-1e-7))fail('minimum_ink_height');
        const polys=treeToPolys(unionTree(result.contours.map(c=>toPath(flattenContour(c,.005))))),{thin,gaps}=thinAndGaps(polys,minimum_stroke_mm);
        if(thin.length)fail('thin_strokes');if(gaps.length)fail('narrow_gaps');
        if(polys.some(p=>Math.abs(polyArea(p.outer))-p.holes.reduce((s,h)=>s+Math.abs(polyArea(h)),0)<minimum_stroke_mm**2))fail('tiny_islands');
        result.version=2;result.printability={minimum_stroke_mm,minimum_ink_height_mm,tolerance_mm:.005,ignored_tip_area_mm2:.12};
      }
      result.engine_sha256=engine;
      const {outline_sha256:prior,...content}=result;result.outline_sha256=sha(JSON.stringify(content));
      process.stdout.write(JSON.stringify({ok:true,result}));
    }
  }
}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e instanceof PersonalizationError?e.code:'outline_generation_failed'}));process.exitCode=1;}
