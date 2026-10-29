import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const script=new URL('../scripts/personalization-region.mjs',import.meta.url).pathname;
const catalog=JSON.parse(spawnSync(process.execPath,[script,'--catalog'],{encoding:'utf8'}).stdout);
const font=catalog.fonts.find(f=>f.id==='bungee');
const request=(extra={})=>({version:2,text:'SAMPLE HOUSE|GAME NIGHT',font_id:font.id,font_sha256:font.sha256,engine_sha256:catalog.engine_sha256,width_mm:70,height_mm:30,margin_mm:2,font_size_mm:10,minimum_font_size_mm:2.5,fit:'scale_to_fit_minimum',align:'center',vertical_align:'middle',line_spacing:1,minimum_stroke_mm:.3,minimum_ink_height_mm:2.5,...extra});
const run=r=>JSON.parse(spawnSync(process.execPath,[script],{input:JSON.stringify(r),encoding:'utf8'}).stdout);
test('real morphology is applied to fitted outlines, and content/engine hashes repeat',()=>{
 const a=run(request()),b=run(request());assert.equal(a.ok,true);assert.deepEqual(a,b);assert.equal(a.result.version,2);assert.equal(a.result.manufacturing_validated,false);assert.equal(a.result.printability.minimum_stroke_mm,.3);
});
test('rejects missing glyphs, changed fonts/engine, tiny ink, unprintable strokes and arbitrary paths',()=>{
 for(const extra of [{text:'A\u{10ffff}'},{engine_sha256:'0'.repeat(64)},{font_sha256:'0'.repeat(64)},{minimum_ink_height_mm:100},{minimum_stroke_mm:2,font_size_mm:2,fit:'fixed',minimum_ink_height_mm:.1},{path:'/tmp/font'}]) assert.equal(run(request(extra)).ok,false,JSON.stringify(extra));
});
test('newline and pipe conventions agree and all registry font byte pins are present',()=>{
 assert.deepEqual(run(request({text:'SAMPLE|HOUSE'})),run(request({text:'SAMPLE\nHOUSE'})));assert.equal(catalog.fonts.length,5);assert.match(catalog.engine_sha256,/^[a-f0-9]{64}$/);
});
