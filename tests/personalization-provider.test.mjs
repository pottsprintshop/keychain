import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/personalization-provider.mjs',import.meta.url));
const legacy=fileURLToPath(new URL('../scripts/personalization-region.mjs',import.meta.url));
const run=(path,r,env=process.env)=>spawnSync(process.execPath,[path,...(r===undefined?['--catalog']:[])],{input:r===undefined?undefined:JSON.stringify(r),encoding:'utf8',env});
const catalog=env=>JSON.parse(run(script,undefined,env).stdout);
const old=JSON.parse(run(legacy).stdout);
const request=(c,id='bungee',extra={})=>({version:2,text:'SAMPLE|HOUSE',font_id:id,font_sha256:c.fonts.find(f=>f.id===id).sha256,engine_sha256:c.engine_sha256,width_mm:70,height_mm:30,margin_mm:2,font_size_mm:10,minimum_font_size_mm:2.5,fit:'scale_to_fit_minimum',align:'center',vertical_align:'middle',line_spacing:1,minimum_stroke_mm:.3,minimum_ink_height_mm:2.5,...extra});
test('legacy engine and all five font outputs remain byte-identical',()=>{
 assert.equal(old.engine_sha256,'8f7929adfc8d671df8e770b67ea68fe4db48c424b42286ab531c29311c7ff6f9');
 for(const font of old.fonts){const r=request(old,font.id,{minimum_stroke_mm:.1});assert.equal(run(script,r).stdout,run(legacy,r).stdout);}
});
test('missing local fonts are explicit, without substitution or changed legacy behavior',()=>{
 const path=mkdtempSync(join(tmpdir(),'keychain-no-fonts-'));try{
  const env={...process.env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:path},c=catalog(env);
  assert.equal(c.default_font_id,'lemon-milk');assert.equal(c.fonts.length,5);assert.ok(c.unavailable_fonts.some(f=>f.id==='lemon-milk'&&f.error==='font_unavailable'));
  const r={...request(c),font_id:'lemon-milk',font_sha256:'0'.repeat(64)};
  assert.equal(JSON.parse(run(script,r,env).stdout).error,'font_unavailable');
  assert.equal(run(script,request(old),env).stdout,run(legacy,request(old)).stdout);
 }finally{rmSync(path,{recursive:true,force:true});}
});
test('wrong bytes cannot masquerade as LEMON MILK',()=>{
 const path=mkdtempSync(join(tmpdir(),'keychain-wrong-font-'));try{
  writeFileSync(join(path,'LEMONMILK-Regular.otf'),'not a font');
  const c=catalog({...process.env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:path});
  assert.ok(!c.fonts.some(f=>f.id==='lemon-milk'));assert.equal(c.unavailable_fonts.find(f=>f.id==='lemon-milk').error,'font_revision_mismatch');
 }finally{rmSync(path,{recursive:true,force:true});}
});
const local=catalog(process.env);const hasRegular=local.fonts.some(f=>f.id==='lemon-milk');
test('actual locally installed Regular generates deterministic multiline CFF outlines',{skip:!hasRegular},()=>{
 const r=request(local,'lemon-milk',{text:'LEMON|MILK'}),a=JSON.parse(run(script,r).stdout),b=JSON.parse(run(script,r).stdout);
 assert.equal(a.ok,true,JSON.stringify(a));assert.deepEqual(a,b);assert.equal(a.result.line_count,2);assert.ok(a.result.contours.some(c=>c.segs.some(s=>s[0]==='C')));
 assert.deepEqual(a,JSON.parse(run(script,{...r,text:'LEMON\nMILK'}).stdout));
 assert.equal(JSON.parse(run(script,{...r,text:'A\u{10ffff}'}).stdout).error,'missing_glyph');
 assert.equal(JSON.parse(run(script,{...r,path:'/tmp/font'}).stdout).ok,false);
 assert.equal(JSON.parse(run(script,{...r,font_sha256:'0'.repeat(64)}).stdout).error,'font_revision_mismatch');
});
test('new engine retains old-font outline coordinates',()=>{
 const c=catalog(process.env),a=JSON.parse(run(legacy,request(old)).stdout),b=JSON.parse(run(script,request(c)).stdout);
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.deepEqual(a.result.contours,b.result.contours);assert.deepEqual(a.result.bounds,b.result.bounds);
});
test('Bold is separately pinned when a licensed local copy is installed',()=>{
 const path=mkdtempSync(join(tmpdir(),'keychain-bold-'));try{
  // Existing repository bytes are used only in a private temporary test directory;
  // this adds no font binary or redistribution grant to the integration.
  copyFileSync(new URL('../fonts/LEMONMILK-Bold.otf',import.meta.url),join(path,'LEMONMILK-Bold.otf'));
  const env={...process.env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:path},c=catalog(env),r=request(c,'lemon-milk-bold');
  assert.equal(c.fonts.find(f=>f.id==='lemon-milk-bold').label,'LEMON MILK Bold');
  assert.equal(JSON.parse(run(script,r,env).stdout).ok,true);
 }finally{rmSync(path,{recursive:true,force:true});}
});
