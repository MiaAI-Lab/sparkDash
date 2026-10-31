import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isolatedConfigEnv} from '../../__tests__/isolatedEnv.js';

test('actual dashboard route is authenticated, read-only, uncached, query-isolated and default-off', {timeout:30000}, async () => {
 for(const enabled of [false,true]) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'overseer-route-'));
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const sparks=path.join(dir,'sparks.json');await fs.writeFile(sparks,'{"sparks":[]}');
  const child=spawn(process.execPath,['server/index.js'],{cwd:path.resolve(import.meta.dirname,'../../..'),env:{...process.env,...isolatedConfigEnv(dir),PORT:String(port),BIND_HOST:'0.0.0.0',SPARKS_JSON_PATH:sparks,SPARKDASH_TOKEN:'fixture-overseer-token',SPARK_OVERSEER_ENABLED:enabled?'1':'0',SPARK_OVERSEER_CONFIG:path.join(dir,'intentionally-missing-config.json')},stdio:['ignore','pipe','pipe']});
  try {
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Fixture dashboard startup deadline')),10000);
    child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture dashboard exited early'))});
    child.stdout.on('data',data=>{if(String(data).includes('server listening')){clearTimeout(timer);resolve()}});
   });
   const url=`http://127.0.0.1:${port}/api/overseer`;
   assert.equal((await fetch(url)).status,401);
   assert.equal((await fetch(url,{headers:{Authorization:'Bearer incorrect'}})).status,401);
   const headers={Authorization:'Bearer fixture-overseer-token'};
   const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const body=await response.json();assert.equal(body.enabled,enabled);assert.equal(body.state,enabled?'unavailable':'disabled');assert.equal(body.summary,null);
   assert.ok(!JSON.stringify(body).includes(dir));assert.ok(!JSON.stringify(body).includes('fixture-overseer-token'));
   assert.equal((await fetch(url+'?journal=/etc/passwd',{headers})).status,400);
   assert.ok((await fetch(url,{method:'POST',headers})).status>=400);
  } finally {
   if(child.exitCode==null){const stopped=once(child,'exit');child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),5000);await stopped;clearTimeout(force)}
   await fs.rm(dir,{recursive:true,force:true});
  }
 }
});
