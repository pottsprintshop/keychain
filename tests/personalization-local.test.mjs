import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const wrapper=fileURLToPath(new URL('../scripts/personalization-local.mjs',import.meta.url));
const direct=fileURLToPath(new URL('../scripts/personalization-provider.mjs',import.meta.url));
const bold=new URL('../fonts/LEMONMILK-Bold.otf',import.meta.url);
const run=(script,input,env)=>spawnSync(process.execPath,[script,...(input===undefined?['--catalog']:[])],{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',env,timeout:10000});
const request=(c,id='lemon-milk-bold')=>({version:2,text:'SAMPLE|HOUSE',font_id:id,font_sha256:c.fonts.find(f=>f.id===id).sha256,engine_sha256:c.engine_sha256,width_mm:70,height_mm:30,margin_mm:2,font_size_mm:10,minimum_font_size_mm:2.5,fit:'scale_to_fit_minimum',align:'center',vertical_align:'middle',line_spacing:1,minimum_stroke_mm:.3,minimum_ink_height_mm:2.5});
test('Font Book renamed/nested files are found by byte identity; layout engine/output unchanged',()=>{
 const home=mkdtempSync(join(tmpdir(),'fontbook-'));try{
  const folder=join(home,'Library/Fonts/Family');mkdirSync(folder,{recursive:true});copyFileSync(bold,join(folder,'Installed Font Book Copy.otf'));
  const env={...process.env,HOME:home};delete env.KEYCHAIN_PERSONALIZATION_FONTS_DIR;
  assert.ok(!JSON.parse(run(direct,undefined,env).stdout).fonts.some(f=>f.id==='lemon-milk-bold')); // Reproduces old lookup failure.
  const c=JSON.parse(run(wrapper,undefined,env).stdout);assert.ok(c.fonts.some(f=>f.id==='lemon-milk-bold'));
  const directFolder=join(home,'pinned');mkdirSync(directFolder);copyFileSync(bold,join(directFolder,'LEMONMILK-Bold.otf'));
  const original=JSON.parse(run(direct,undefined,{...env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:directFolder}).stdout);
  assert.equal(c.engine_sha256,original.engine_sha256);assert.equal(c.engine_sha256,'15b567f00010068db288ab489d4b7112a3201900831c6be77aa5da6b219ab732');
  assert.equal(run(wrapper,request(c),env).stdout,run(direct,request(original),{...env,KEYCHAIN_PERSONALIZATION_FONTS_DIR:directFolder}).stdout);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('operator override does not fall back; mismatched pinned filenames remain explicit',()=>{
 const home=mkdtempSync(join(tmpdir(),'fontbook-override-'));try{
  const fonts=join(home,'Library/Fonts');mkdirSync(fonts,{recursive:true});copyFileSync(bold,join(fonts,'LEMONMILK-Bold.otf'));
  const empty=join(home,'empty');mkdirSync(empty);const env={...process.env,HOME:home,KEYCHAIN_PERSONALIZATION_FONTS_DIR:empty};
  let c=JSON.parse(run(wrapper,undefined,env).stdout);assert.ok(!c.fonts.some(f=>f.id==='lemon-milk-bold'));
  writeFileSync(join(empty,'LEMONMILK-Bold.otf'),'not the pinned font');c=JSON.parse(run(wrapper,undefined,env).stdout);
  assert.equal(c.unavailable_fonts.find(f=>f.id==='lemon-milk-bold').error,'font_revision_mismatch');
  const result=run(wrapper,{version:2,path:'/tmp/font'},env);assert.notEqual(result.status,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('system Font Book location uses identical hash resolution and bounded nested traversal',async()=>{
 const {fontDirectories,installedFonts}=await import('../scripts/fontbook-discovery.mjs');
 assert.deepEqual(fontDirectories({},'/portable-home'),['/portable-home/Library/Fonts','/Library/Fonts']);
 assert.deepEqual(fontDirectories({KEYCHAIN_PERSONALIZATION_FONTS_DIR:''},'/portable-home'),['']);
 const home=mkdtempSync(join(tmpdir(),'fontbook-system-'));try{
  const fonts=join(home,'Library/Fonts/Font Book');mkdirSync(fonts,{recursive:true});copyFileSync(bold,join(fonts,'renamed-bold.otf'));
  const {readFileSync}=await import('node:fs');
  const registry=JSON.parse(readFileSync(new URL('../scripts/personalization-local-fonts.json',import.meta.url)));
  const {found}=await installedFonts(registry,[join(home,'Library/Fonts')]);
  assert.equal(found.get('lemon-milk-bold'),join(fonts,'renamed-bold.otf'));
 }finally{rmSync(home,{recursive:true,force:true});}
});

const regular=join(homedir(),'Library/Fonts/LEMONMILK-Regular.otf');
test('actual installed Regular survives a Font Book rename and generates multiline outlines',{skip:!existsSync(regular)},()=>{
 const home=mkdtempSync(join(tmpdir(),'fontbook-regular-'));try{
  const fonts=join(home,'Library/Fonts');mkdirSync(fonts,{recursive:true});copyFileSync(regular,join(fonts,'LEMON MILK Regular.otf'));
  const env={...process.env,HOME:home};delete env.KEYCHAIN_PERSONALIZATION_FONTS_DIR;
  assert.ok(!JSON.parse(run(direct,undefined,env).stdout).fonts.some(f=>f.id==='lemon-milk'));
  const c=JSON.parse(run(wrapper,undefined,env).stdout),result=JSON.parse(run(wrapper,request(c,'lemon-milk'),env).stdout);
  assert.equal(result.ok,true);assert.equal(result.result.line_count,2);
 }finally{rmSync(home,{recursive:true,force:true});}
});
