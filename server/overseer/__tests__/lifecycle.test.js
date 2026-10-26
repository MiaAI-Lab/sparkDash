import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOverseerRuntime} from '../runtime.js';

test('start/close are idempotent and unexpected collector failures become unavailable, not unhandled rejections',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'overseer-lifecycle-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'config.json');await fs.writeFile(config,JSON.stringify({sources:[{sparkId:'a',journal:path.join(dir,'a.ndjson')}]}));
 let reads=0,registryFails=false;
 const runtime=createOverseerRuntime({enabled:true,configFile:config,getUnits:()=>{if(registryFails)throw Error('fixture registry error');return[{id:'a'}]},read:async()=>{reads++;return{lines:[]}}});
 t.after(()=>runtime.close());await runtime.start();await runtime.start();assert.equal(reads,1);
 registryFails=true;await runtime.poll();registryFails=false;assert.equal(runtime.snapshot().state,'unavailable');assert.equal(runtime.snapshot().summary,null);
 await runtime.close();await runtime.close();await runtime.start();await runtime.poll();assert.equal(reads,1);
});
