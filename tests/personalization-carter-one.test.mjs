import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/personalization-provider.mjs',import.meta.url));
const PRIOR='15b567f00010068db288ab489d4b7112a3201900831c6be77aa5da6b219ab732'; // engine id before Carter One joined the registry
const CARTER='f63f882384d92400c96d8b13b360f69b24724e20880c16a66de21bf350256de0';
const run=(r,env)=>spawnSync(process.execPath,[script,...(r===undefined?['--catalog']:[])],{input:r===undefined?undefined:JSON.stringify(r),encoding:'utf8',env});
const request=(c,id,engine=c.engine_sha256)=>({version:2,text:'SAMPLE|HOUSE',font_id:id,font_sha256:c.fonts.find(f=>f.id===id).sha256,engine_sha256:engine,width_mm:70,height_mm:30,margin_mm:2,font_size_mm:10,minimum_font_size_mm:2.5,fit:'scale_to_fit_minimum',align:'center',vertical_align:'middle',line_spacing:1,minimum_stroke_mm:.3,minimum_ink_height_mm:2.5});
function withFonts(fn){
  const dir=mkdtempSync(join(tmpdir(),'keychain-carter-'));
  try{
    for(const f of ['LEMONMILK-Bold.otf','CarterOne-Regular.ttf'])copyFileSync(new URL('../fonts/'+f,import.meta.url),join(dir,f)); // private temp copy, no redistribution
    return fn({...process.env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:dir});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('Carter One is in the real catalog under its pinned font bytes and the current engine only',()=>withFonts(env=>{
  const c=JSON.parse(run(undefined,env).stdout),f=c.fonts.find(x=>x.id==='carter-one');
  assert.equal(f.label,'Carter One');assert.equal(f.sha256,CARTER);assert.deepEqual(f.supported_engine_sha256,[c.engine_sha256]);
  assert.notEqual(c.engine_sha256,PRIOR);assert.ok(c.supported_engine_sha256.includes(PRIOR));
}));
test('real Carter One outlines are generated, deterministic and printable',()=>withFonts(env=>{
  const c=JSON.parse(run(undefined,env).stdout),a=run(request(c,'carter-one'),env),b=run(request(c,'carter-one'),env);
  const out=JSON.parse(a.stdout);assert.equal(out.ok,true);assert.equal(out.result.engine_sha256,c.engine_sha256);
  assert.ok(out.result.contours.length>0&&out.result.line_count===2);assert.equal(a.stdout,b.stdout);
}));
test('Carter One is refused under a prior engine pin, never substituted',()=>withFonts(env=>{
  const c=JSON.parse(run(undefined,env).stdout),r=run(request(c,'carter-one',PRIOR),env);
  assert.notEqual(r.status,0);assert.equal(JSON.parse(r.stdout).error,'engine_revision_mismatch');
}));
test('saved features pinned to the prior engine keep byte-identical output (digests from the pre-Carter provider)',()=>withFonts(env=>{
  const c=JSON.parse(run(undefined,env).stdout);
  const golden={'lemon-milk-bold':'e1afd74ab39fadd546f010dc97ed1c24583f74575ebe4796a9fa375f4bdd8eee',bungee:'fb298a14052dd2d5c204ec20e6162db69b1ae21fe0c0459f3933fd2836638760'};
  for(const [id,digest] of Object.entries(golden)){
    const r=run(request(c,id,PRIOR),env);assert.equal(r.status,0,id);
    assert.equal(createHash('sha256').update(r.stdout).digest('hex'),digest,id);
    assert.equal(JSON.parse(r.stdout).result.engine_sha256,PRIOR); // the saved pin is echoed, not re-pinned
  }
}));
