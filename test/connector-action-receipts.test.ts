import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { ConnectorActionReceipts } from '../src/connectors/action-receipts';
import { ConnectorError } from '../src/connectors/app-connector';
import { AgentConnectorService } from '../src/connectors/service';
const scope={surface:'cli',sessionId:'alice'}, request={operation:'issue.create',args:{title:'private title',owner:'agent',repo:'test'}};
const withStore=async (fn:(store:ConnectorActionReceipts,root:string)=>Promise<void>) => {const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-receipts-'));try {await fn(new ConnectorActionReceipts(root),root);}finally{fs.rmSync(root,{recursive:true,force:true});}};

test('succeeded call replays original response after restart but a new intent remains allowed',()=>withStore(async(store,root)=>{
  let calls=0;const invoke=async()=>{calls++;return {data:{id:123}};};
  assert.deepEqual(await store.execute('github',request,scope,'call-1',invoke),{data:{id:123}});
  assert.deepEqual(await new ConnectorActionReceipts(root).execute('github',{...request,args:{repo:'test',owner:'agent',title:'private title'}},scope,'call-1',invoke),{data:{id:123}});
  assert.equal(calls,1);await store.execute('github',request,scope,'call-2',invoke);assert.equal(calls,2);
  assert.equal(JSON.stringify(store.list()).includes('private title'),false);assert.equal(JSON.stringify(store.list()).includes('123'),false);
}));
test('call identity conflict and live identical writes never reach app',()=>withStore(async(store)=>{
  let release!:(v:any)=>void;const running=store.execute('github',request,scope,'call',()=>new Promise(r=>release=r));
  await assert.rejects(store.execute('github',request,{surface:'pet',sessionId:'bob'},'different',async()=>({data:null})),/unknown outcome/);
  const id=store.list()[0].id;assert.throws(()=>store.review(id),/live process/);
  release({data:{id:1}});await running;
  await assert.rejects(store.execute('github',{...request,args:{...request.args,title:'changed'}},scope,'call',async()=>({data:null})),/different arguments/);
}));
test('lost write response blocks duplicate across restart and sessions until local reconciliation',()=>withStore(async(store,root)=>{
  let calls=0;
  await assert.rejects(store.execute('github',request,scope,'one',async()=>{calls++;throw new ConnectorError('CONNECTOR_NETWORK_ERROR','lost response');}),/lost response/);
  const restored=new ConnectorActionReceipts(root), id=restored.list()[0].id;
  assert.equal(restored.list()[0].status,'uncertain');
  await assert.rejects(restored.execute('github',request,{surface:'pet',sessionId:'bob'},'two',async()=>{calls++;return {data:null};}),/unknown outcome/);
  assert.equal(calls,1);restored.review(id);
  await assert.rejects(restored.execute('github',request,scope,'one',async()=>({data:null})),/already attempted/);
  await restored.execute('github',request,scope,'new-confirmed-action',async()=>{calls++;return {data:null};});assert.equal(calls,2);
}));
test('definite HTTP rejection permits new confirmed action; corrupt receipts block writes',()=>withStore(async(store,root)=>{
  await assert.rejects(store.execute('github',request,scope,'one',async()=>{throw new ConnectorError('CONNECTOR_API_ERROR','rejected',false,422);}),/rejected/);
  assert.equal(store.list()[0].status,'rejected');await store.execute('github',request,scope,'two',async()=>({data:null}));
  fs.writeFileSync(path.join(root,'data/connectors/actions',store.list()[0].id+'.json'),'{}');
  await assert.rejects(store.execute('github',request,scope,'three',async()=>({data:null})),/Corrupt/);
}));
test('killed worker leaves running evidence; restart blocks until checked review',()=>withStore(async(store,root)=>{
  const script=path.join(root,'worker.cjs');const modulePath=path.resolve('dist/connectors/action-receipts.js');
  fs.writeFileSync(script,`const {ConnectorActionReceipts}=require(${JSON.stringify(modulePath)});const s=new ConnectorActionReceipts(${JSON.stringify(root)});s.execute('github',${JSON.stringify(request)},${JSON.stringify(scope)},'crashed',()=>new Promise(()=>{process.send('claimed');setInterval(()=>{},1000);}));`);
  const child=fork(script,[],{silent:true});
  try {await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error('early exit')));});}
  finally {child.kill('SIGKILL');await new Promise<void>(r=>child.once('exit',()=>r()));}
  const restored=new ConnectorActionReceipts(root);assert.equal(restored.list()[0].status,'running');
  await assert.rejects(restored.execute('github',request,scope,'retry',async()=>({data:null})),/unknown outcome/);
  restored.review(restored.list()[0].id);await restored.execute('github',request,scope,'checked-new-action',async()=>({data:{id:2}}));
}));
test('production service integrates receipts and rechecks requester and disabled connection on replay',()=>withStore(async(_store,root)=>{
  let calls=0;const credentials={configured:()=>true,token:async()=> 'secret'};
  const fetcher:typeof fetch=async()=>{calls++;return new Response('{"number":5}',{headers:{'content-type':'application/json'}});};
  const service=new AgentConnectorService(root,{credentials,fetcher});
  await service.invoke('github',request,scope,{actionId:'call'});await service.invoke('github',request,scope,{actionId:'call'});assert.equal(calls,1);
  await assert.rejects(service.invoke('github',request,{...scope,parentSessionId:'parent'},{actionId:'call'}),/requester/);
  service.config.configure('github',false);await assert.rejects(service.invoke('github',request,scope,{actionId:'call'}),/disabled/);assert.equal(calls,1);
}));
