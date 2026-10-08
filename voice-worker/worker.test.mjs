import test from "node:test";
import assert from "node:assert/strict";

function stripPunctuation(t){return String(t||"").replace(/[\p{P}\p{S}]/gu," ").replace(/\s+/g," ").trim();}
function splitWords(text,maxWords=4){const w=stripPunctuation(text).split(/\s+/).filter(Boolean),o=[];for(let i=0;i<w.length;i+=maxWords)o.push(w.slice(i,i+maxWords).join(" "));return o;}
function cleanPcm(raw,rate=24000){const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw||0);const n=Math.floor(bytes.byteLength/2);const v=new DataView(bytes.buffer,bytes.byteOffset,n*2);let peak=0;for(let i=0;i<n;i++)peak=Math.max(peak,Math.abs(v.getInt16(i*2,true)));const th=Math.max(20,Math.min(160,Math.round(peak*.035)));let first=-1,last=-1;for(let i=0;i<n;i++)if(Math.abs(v.getInt16(i*2,true))>=th){if(first<0)first=i;last=i;}const pad=Math.round(rate*.18),s=Math.max(0,first-pad),e=Math.min(n,last+pad+1);const out=new Int16Array(e-s);return {duration:out.length/rate,rawDuration:n/rate};}

test("splits to four words",()=>assert.ok(splitWords("هلا عيني الحمد لله زين وإنت شلونك شخبارك",4).every(x=>x.split(/\s+/).length<=4)));
test("trims 320 second padding",()=>{const r=24000,a=new Int16Array(r*320);for(let i=r/10;i<r*3;i++)a[i]=1200;const o=cleanPcm(new Uint8Array(a.buffer),r);assert.ok(o.rawDuration>319);assert.ok(o.duration>2&&o.duration<4);});
