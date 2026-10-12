const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { createBrowserProfile, removeBrowserProfile, resolveBrowserConfig, sandboxArguments } = require('./i18n-browser-config.cjs');
const repo = process.cwd();
// Resolve this before creating the fixture server so missing browsers fail quickly.
const browserConfig = resolveBrowserConfig({ repo });
const out = browserConfig.out;
const browserBinary = browserConfig.binary;
const { WebSocket, WebSocketServer } = createRequire(path.join(repo, 'package.json'))('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const { getSettings } = await import(pathToFileURL(path.join(repo, 'server/settings.js')));
  const { makeSpark } = await import(pathToFileURL(path.join(repo, 'src/testing/fixtures.ts')));
  const { publicSpec } = await import(pathToFileURL(path.join(repo, 'server/tooleval/spec.js')));
  const settings = { ...getSettings(), showFleetEnergy: true, showLlmTokenTotals: true, showActivityFeed: true, electricityPrice: 0.5, electricityCurrency: 'CNY' };
  const spark = { ...makeSpark('test-host'), name: 'Test GPU', lanIp: '192.0.2.1', isLocal: false };
  const config = {id:spark.id,name:spark.name,kind:'spark',lanIp:spark.lanIp,isLocal:false,ssh:{host:spark.lanIp,user:'fixture',auth:'key'},llmPorts:[8888],llmMonitoring:true};
  const now = Date.now(), hour = 3600000;
  const hours = Array.from({length:48}, (_,i)=>Math.floor((now-(47-i)*hour)/hour)*hour);
  const tokenRows = hours.map((t,i)=>({t:new Date(t).toISOString().slice(0,13),sparkId:spark.id,port:8888,modelId:'fixture-model',promptTokens:1000+i*10,completionTokens:500+i*5,cachedTokens:100}));
  const tokenHistory = {generatedAt:now,retention:{days:35,hours:72},firstDay:new Date(hours[0]).toISOString().slice(0,10),firstHour:tokenRows[0].t,day:[],hour:tokenRows};
  for(const row of tokenRows) { const day=row.t.slice(0,10); let dest=tokenHistory.day.find(r=>r.t===day); if(!dest){dest={...row,t:day,promptTokens:0,completionTokens:0,cachedTokens:0};tokenHistory.day.push(dest)} for(const k of ['promptTokens','completionTokens','cachedTokens'])dest[k]+=row[k]; }
  const energyHistory={estimated:true,membershipChanged:false,generatedAt:now,retentionMs:31*86400000,nodeIds:[spark.id],hourly:hours.map(t=>({t,nodeWh:{[spark.id]:100},nodeCoverageMs:{[spark.id]:hour},avgWatts:100,fleetEnergyWh:100,fleetCoverageMs:hour,outputTokens:10000,coveredOutputTokens:10000}))};
  const fleetEnergy={estimated:true,membershipChanged:false,restartRequired:false,trackedNodeIds:[spark.id],currentNodeIds:[spark.id],freshNodeCount:1,staleNodeIds:[],currentWatts30s:100,energy24hKwh:2.4,energy31dKwh:4.8,whPerOutputToken24h:0.01,outputTokens24h:240000,coverage24hMs:86400000,coverage31dMs:172800000,nodeCoverage24hMs:{[spark.id]:86400000},nodeCoverage31dMs:{[spark.id]:172800000},hourlyWatts24h:Array(24).fill(100)};
  const monthly={estimated:true,generatedAt:now,foldedThroughMs:hours[0],months:[{month:'2026-10',startMs:Date.UTC(2026,9,1),endMs:Date.UTC(2026,10,1),closed:false,nodeIds:[spark.id],nodes:{[spark.id]:{wh:4800,coverageMs:172800000}},totalWh:4800,fleetWh:4800,fleetCoverageMs:172800000,outputTokens:480000,coveredOutputTokens:480000,whPerOutputToken:0.01}]};
  const events=[{id:3,ts:now-3000,type:'spark.online',sparkId:spark.id,sparkName:spark.name,severity:'info',message:'Test GPU is online',data:{}},{id:2,ts:now-40000,type:'power.shutdown',sparkId:spark.id,sparkName:spark.name,severity:'info',message:'Shutdown requested',data:{}},{id:1,ts:now-80000,type:'bench.completed',sparkId:spark.id,sparkName:spark.name,severity:'info',message:'Decode benchmark completed',data:{kind:'decode'}}];
  const writes=[], unknownRoutes=new Set();
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost'), p=url.pathname;
    if(p.startsWith('/api/')){
      if(req.method!=='GET')writes.push({method:req.method,path:p});
      let data;
      if(req.method==='DELETE')data={removed:1,success:true};
      else if(p==='/api/settings')data=settings;
      else if(p==='/api/auth/status')data={tokenRequired:false,authenticated:true};
      else if(p==='/api/health')data={ok:true,authMode:'loopback-open',errors:[],warnings:[]};
      else if(p==='/api/restart')data={available:false};
      else if(p==='/api/sparks')data={sparks:[config]};
      else if(p==='/api/events')data={events,oldestId:1};
      else if(p==='/api/fleet-energy')data=fleetEnergy;
      else if(p==='/api/fleet-energy/history')data=energyHistory;
      else if(p==='/api/fleet-energy/monthly')data=monthly;
      else if(p==='/api/llm-token-totals/history')data=tokenHistory;
      else if(p==='/api/llm-token-totals')data={range:'all',series:[{sparkId:spark.id,port:8888,updatedAt:now,lastModelId:'fixture-model',totals:{promptTokens:100000,completionTokens:50000,cachedTokens:1000},models:[{modelId:'fixture-model',promptTokens:100000,completionTokens:50000,cachedTokens:1000,lastSeenAt:now}]}]};
      else if(p==='/api/tool-eval/spec')data={...publicSpec(),types:{'tool-eval':'Tool Eval Bench'},install:{extras:['accuracy','needle']}};
      else if(p.endsWith('/metrics'))data={metrics:spark.metrics};
      else if(p.endsWith('/gpu-history'))data={series:[],points:[]};
      else if(p.endsWith('/llm/daily'))data={days:[],rows:[]};
      else if(p.endsWith('/llm-launchers'))data={launchers:[],recipes:[],jobs:[]};
      else if(p.endsWith('/shutdown'))data={success:true,message:'Shutdown initiated'};
      else if(p.endsWith('/tool-eval/status'))data={reachable:true,installed:true,version:'0.0-fixture',path:'/fixture/tool-eval-bench',uv:'uv',python:'python3',pythonVersion:'3.12',workDir:'/fixture',error:null};
      else if(p.endsWith('/tool-eval/update-check'))data={installed:true,upToDate:true,error:null};
      else if(p.endsWith('/tool-eval/runs'))data={runs:[],active:null};
      else if(p.endsWith('/tool-eval/install-command'))data={command:'uv tool install tool-eval-bench'};
      else if(p.endsWith('/tool-eval/preview'))data={ok:true,command:'tool-eval-bench --base-url http://fixture:8888',port:8888,usesSavedKey:false};
      else if(p.endsWith('/llm/showcase'))data={history:[],active:null};
      else if(/\/llm\/(bench|prefill-bench|quality-bench)$/.test(p))data={history:[],active:null};
      else {unknownRoutes.add(p);data={events:[],series:[],jobs:[],recipes:[],sparks:[],history:[],active:null};}
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
    }
    const dist=path.join(repo,'dist');let file=path.resolve(dist,'.'+p);
    if(!file.startsWith(dist)){res.writeHead(403);res.end();return;}
    if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(dist,'index.html');
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime});res.end(fs.readFileSync(file));
  });
  const wss=new WebSocketServer({server});
  const snapshot=()=>JSON.stringify({type:'snapshot',sparks:[spark],generatedAt:Date.now(),refreshInterval:2000});
  wss.on('connection',ws=>ws.send(snapshot()));
  const timer=setInterval(()=>{for(const ws of wss.clients)if(ws.readyState===1)ws.send(snapshot())},2000);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const appUrl='http://127.0.0.1:'+server.address().port;
  const portReservation=require('node:net').createServer();
  await new Promise(r=>portReservation.listen(0,'127.0.0.1',r));
  const cdpPort=portReservation.address().port;
  await new Promise(r=>portReservation.close(r));
  let profile;
  let browser;
  let spawnError;
  let socket;
  const checks=[], errors=[], texts=[];
  try{
    profile=createBrowserProfile();
    try {
    browser=spawn(browserBinary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port='+cdpPort,'--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,...sandboxArguments(),'about:blank'],{windowsHide:true,stdio:'ignore'});
    browser.once('error', error => { spawnError = error; });
    browser.once('exit', code => { if (code !== 0) spawnError ||= new Error('browser exited with code '+code); });
    } catch (error) {
    spawnError = error;
    }
    let pages;for(let i=0;i<50;i++){if(spawnError)throw new Error('Browser launch failed: '+spawnError.message);try{pages=await(await fetch('http://127.0.0.1:'+cdpPort+'/json/list')).json();if(pages.some(p=>p.type==='page'))break}catch{}await sleep(100)}
    const target=pages?.find(p=>p.type==='page');assert(target,'Edge started');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.once('open',r));
    let id=0;const pending=new Map();socket.on('message',raw=>{const msg=JSON.parse(raw);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result)}if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text)});
    const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}))});
    const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
    const wait=async(expression)=>{for(let i=0;i<60;i++){if(await evaluate(expression))return;await sleep(100)}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText.slice(0,2500)')+'\n'+JSON.stringify(errors))};
    const click=async(label)=>{const hit=await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)} && b.getBoundingClientRect().width>0);if(b){b.click();return true}return false})()`);assert(hit,'button '+label)};
    const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'))};
    const closeSettings=()=>evaluate('document.querySelector(".settings-panel .modal-sheet__close")?.click()');
    const switchLocale=async locale=>{
      const current=await evaluate('document.documentElement.lang');
      const opened=await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('.rail-settings button,.tabbar button')).find(b=>b.textContent.trim()===${JSON.stringify(current==='en'?'Settings':'设置')}&&b.getBoundingClientRect().width>0);if(b){b.click();return true}return false})()`);assert(opened,'shell settings button');await wait('document.querySelector("#settings-title") !== null');
      await click(locale==='en'?'English':'简体中文');await wait('document.documentElement.lang === '+JSON.stringify(locale));
      await closeSettings();await wait('document.querySelector("#settings-title") === null');await sleep(150);
    };
    const audit=async(route,viewport,locale)=>{
      await sleep(180);
      const data=await evaluate(`({text:document.body.innerText,main:document.querySelector('main')?.innerText||document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth+1,overflows:Array.from(document.querySelectorAll('main *')).filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>innerWidth+2).slice(0,6).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right])})`);
      assert.equal(data.overflow,false,route+' '+viewport+' horizontal overflow '+JSON.stringify(data.overflows));
      assert(!/\b(?:common|shell|overview|spark|bench|showcase|tokens|energy|activity|health|server|ui)\.[A-Za-z]+\.[A-Za-z]+/.test(data.text),'no exposed key '+route);
      if(locale==='zh-Hans')assert(/[\u4e00-\u9fff]/.test(data.main),'Chinese body '+route);
      else assert(!/[\u4e00-\u9fff]/.test(data.main),'English body '+route);
      checks.push({route,viewport,locale,overflow:false});texts.push({route,viewport,locale,text:data.text});
      await shot(route.replace(/\W+/g,'-')+'-'+viewport+'-'+locale);
    };
    await cdp('Runtime.enable');await cdp('Page.enable');
    const routes=['/','/tokens','/energy','/activity','/showcase','/bench/decode','/bench/prefill','/bench/quality','/bench/tool-eval','/spark/test-host'];
    for(const [viewport,width,height,mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]){
      await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
      for(const route of routes){
        await cdp('Page.navigate',{url:appUrl+route});await wait('document.querySelector("main") !== null && document.body.innerText.includes("Test GPU")');
        if(await evaluate('document.documentElement.lang')!=='zh-Hans')await switchLocale('zh-Hans');
        await audit(route,viewport,'zh-Hans');await switchLocale('en');await audit(route,viewport,'en');await switchLocale('zh-Hans');
        await cdp('Page.reload');await wait('document.documentElement.lang === "zh-Hans" && document.querySelector("main") !== null');
        assert.equal(await evaluate('localStorage.getItem("sparkdash-locale")'),'zh-Hans');
      }
    }
    // Destructive confirmation is exercised only against this isolated fixture server.
    await cdp('Page.navigate',{url:appUrl+'/activity'});await wait('document.querySelector(".ac-clear button") && !document.querySelector(".ac-clear button").disabled');
    await evaluate('document.querySelector(".ac-clear button").click()');await wait('document.querySelector(".ac-clear__item") !== null');
    await evaluate('document.querySelector(".ac-clear__item").click()');await wait('document.querySelector(".ac-clear__confirm") !== null');
    const zhAsk=await evaluate('document.querySelector(".ac-clear__confirm").innerText');assert(/[\u4e00-\u9fff]/.test(zhAsk));
    await switchLocale('en');await wait('document.querySelector(".ac-clear__confirm") !== null');
    const enAsk=await evaluate('document.querySelector(".ac-clear__confirm").innerText');assert(!/[\u4e00-\u9fff]/.test(enAsk));
    await evaluate('document.querySelector(".ac-clear__confirm .btn--danger").click()');await wait('document.querySelector(".ac-toast").innerText.includes("Deleted")');
    checks.push({flow:'delete confirmation changes language and mocked delete success',zhAsk,enAsk});
    // Independent full-screen showcase has the same persisted browser preference.
    await switchLocale('zh-Hans');await cdp('Page.navigate',{url:appUrl+'/spark/test-host'});await wait('document.querySelector("main") && document.body.innerText.includes("Test GPU")');
    await click('关机');await wait('document.querySelector("input[placeholder=poweroff]") !== null');
    assert(/[\u4e00-\u9fff]/.test(await evaluate('document.querySelector("[role=dialog]").innerText')));
    await sleep(100);
    await evaluate('document.querySelector("[role=dialog] input[type=checkbox]").click();document.querySelector("input[placeholder=poweroff]").focus()');
    await cdp('Input.insertText',{text:'poweroff'});await wait('!document.querySelector("[role=dialog] .btn--danger").disabled');
    await evaluate('document.querySelector("[role=dialog] .btn--danger").click()');await wait('document.querySelector(".sp-flash")?.innerText.includes("关机")');
    await switchLocale('en');await wait('document.querySelector(".sp-flash")?.innerText.includes("Shutdown initiated")');
    checks.push({flow:'mocked shutdown confirmation and locale-reactive success notice'});
    await switchLocale('zh-Hans');await cdp('Page.navigate',{url:appUrl+'/showcase/test-host'});await wait('document.body.innerText.includes("Test GPU")');await audit('/showcase/test-host','mobile','zh-Hans');
    assert.deepEqual(errors,[],'uncaught JS errors');
    assert(writes.every(w=>w.path.includes('/tool-eval/preview')||w.path.endsWith('/shutdown')||w.method==='DELETE'),'Only expected mocked writes '+JSON.stringify(writes));
    fs.writeFileSync(path.join(out,'browser-check.json'),JSON.stringify({passed:true,checks,errors,writes,unknownRoutes:[...unknownRoutes],fixture:'Local synthetic fleet, token/energy history and legacy events. No real device actions.'},null,2));
    fs.writeFileSync(path.join(out,'visible-text.json'),JSON.stringify(texts,null,2));
    console.log('Browser validation passed '+checks.length+' checks: '+out);await cdp('Browser.close');
  }catch(error){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),checks,errors,writes,texts},null,2));throw error}
  finally{clearInterval(timer);socket?.close();browser?.kill();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(r=>server.close(r));try{if(profile&&!removeBrowserProfile(profile))console.error('Skipped cleanup of an unowned browser profile')}catch(cleanupError){console.error('Browser profile cleanup failed: '+cleanupError)}}
}
main().catch(error=>{console.error(error);process.exitCode=1});
