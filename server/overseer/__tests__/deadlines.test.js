import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOverseerRuntime} from '../runtime.js';
import {observation} from '../journal.js';

test('stalled sources do not overlap, block other units, or keep close waiting forever', {timeout:2000}, async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'overseer-deadline-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'config.json');
 await fs.writeFile(config,JSON.stringify({sources:[{sparkId:'slow',journal:path.join(dir,'slow')},{sparkId:'fast',journal:path.join(dir,'fast')}]}));
 let reads=0,release;
 const stuck=new Promise(resolve=>{release=resolve});
 const data={lines:[JSON.stringify(observation('ordinary'))],pending:false,truncated:false,full:false};
 const runtime=createOverseerRuntime({enabled:true,configFile:config,pollMs:10000,readTimeoutMs:15,getUnits:()=>[{id:'slow'},{id:'fast'}],read:async file=>{if(file.endsWith('slow')){reads++;return stuck;}return data;}});
 t.after(()=>runtime.close());
 await runtime.start();await runtime.poll();
 assert.equal(reads,1,'never start another read while a source remains stuck');
 assert.equal(runtime.snapshot().sources.find(s=>s.sparkId==='slow').state,'unavailable');
 assert.equal(runtime.snapshot().sources.find(s=>s.sparkId==='fast').state,'readable');
 assert.equal(runtime.snapshot().events.length,1);
 await runtime.close();release(data);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runtime.snapshot().events.length,1,'late completion cannot publish after close');
});
