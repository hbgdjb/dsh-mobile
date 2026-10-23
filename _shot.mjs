import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const ROOT = new URL(".", import.meta.url).pathname;
const MIME={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".png":"image/png",".json":"application/json",".webmanifest":"application/manifest+json",".svg":"image/svg+xml"};
const s=createServer(async(req,res)=>{try{let p=req.url.split("?")[0];if(p==="/")p="/index.html";const f=join(ROOT,normalize(p));const b=await readFile(f);res.writeHead(200,{"content-type":MIME[extname(f)]||"application/octet-stream"});res.end(b)}catch{res.writeHead(404);res.end("nf")}});
await new Promise(r=>s.listen(0,r));
const port=s.address().port;
const b=await chromium.launch({executablePath:"/usr/bin/chromium",args:["--no-sandbox","--force-device-scale-factor=2"]});
const p=await b.newPage({viewport:{width:412,height:915},deviceScaleFactor:2});
await p.addInitScript(()=>{
  delete window.SpeechRecognition; delete window.webkitSpeechRecognition;
  window.DshSpeech={isAvailable:()=>true,hasPermission:()=>true,requestPermission:()=>{},start:()=>{
    setTimeout(()=>window.__dshSpeechEvent({type:"ready"}),20);
    setTimeout(()=>window.__dshSpeechEvent({type:"volume",rms:8}),60);
    setTimeout(()=>window.__dshSpeechEvent({type:"partial",text:"帮我写一份这周的周报"}),120);
  },stop:()=>{},cancel:()=>{}};
});
await p.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:"networkidle"});
await p.waitForTimeout(800);
// 进入一个会话，让页面像真实使用
await p.evaluate(async()=>{
  const st=await import("/scripts/store.js");
  st.createSession({mode:"standard",title:"周会"});
  st.save(true);
});
await p.reload({waitUntil:"networkidle"});
await p.waitForTimeout(900);
await p.fill("#composer-input","");
await p.click("#voice-btn");
await p.waitForTimeout(400);
await p.screenshot({path:"artifacts/voice-listening.png",clip:{x:0,y:700,width:412,height:215}});
// 再来一张全屏
await p.screenshot({path:"artifacts/voice-full.png"});
await b.close(); s.close();
console.log("ok");
