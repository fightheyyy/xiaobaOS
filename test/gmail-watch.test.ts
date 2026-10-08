import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GmailWatchStore,tickGmailWatch } from '../src/connectors/gmail-watch';
import { AgentConnectorService } from '../src/connectors/service';
import { SessionReminderStore,tickSessionReminders,registerReminderRoute } from '../src/events/session-reminders';
import { EventDispatcher } from '../src/events/dispatcher';
const owner={surface:'pet' as const,sessionKey:'pet:alice',channelId:'alice'};
const setup=async(fn:(root:string,watch:GmailWatchStore)=>Promise<void>)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-watch-'));try{const watch=new GmailWatchStore(root);watch.configure(owner);await fn(root,watch);}finally{fs.rmSync(root,{recursive:true,force:true});}};
function service(root:string,reply:(url:URL)=>any) {return new AgentConnectorService(root,{credentials:{configured:()=>true,token:async()=> 'secret'},fetcher:async(input)=>{const data=reply(new URL(String(input)));return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});}});}
const at=(minutes:number)=>new Date(Date.UTC(2026,9,8,0,minutes));
test('watch is opt-in, validates target and baselines old mail without wakeups',()=>setup(async(root,watch)=>{
  assert.throws(()=>watch.configure({...owner,surface:'agent' as any}),/TARGET/);assert.equal(watch.read()!.surface,'pet');
  let calls=0;const app=service(root,()=>{calls++;return {emailAddress:'agent@test.com',historyId:'10'};});
  await tickGmailWatch(root,at(0),app);assert.equal(calls,1);assert.equal(watch.read()!.historyId,'10');assert.deepEqual(new SessionReminderStore(root).list(),[]);
  await tickGmailWatch(root,new Date(at(0).getTime()+1000),app);assert.equal(calls,1);
  watch.configure(owner,false);await tickGmailWatch(root,at(1),app);assert.equal(calls,1);
}));
test('new mail admits deterministic Events and offline checks; replay duplicates do not recreate checks',()=>setup(async(root,watch)=>{
  const app=service(root,url=>url.pathname.endsWith('/profile')?{emailAddress:'agent@test.com',historyId:'20'}:{historyId:'20',history:[{id:'15',messagesAdded:[{message:{id:'m1'}}]}]});
  watch.write({...watch.read()!,historyId:'10',accountHash:undefined});
  const first=await tickGmailWatch(root,at(0),app);assert.equal(first.admitted,1);
  const records=new SessionReminderStore(root).list();assert.equal(records.length,1);assert.equal(records[0].sessionKey,owner.sessionKey);assert.equal(records[0].mode,'check');
  assert.match(records[0].purpose,/m1/);assert.equal(new EventDispatcher(path.join(root,'data/events')).list()[0].event.source.kind,'connector');
  assert.equal((await tickSessionReminders(root,at(1))).deferred.length,1);
  // Force the old page to replay after a lost cursor update.
  watch.write({...watch.read()!,historyId:'10',lastPollAt:undefined});assert.equal((await tickGmailWatch(root,at(1),app)).admitted,0);
  assert.equal(new SessionReminderStore(root).list().length,1);
  let consumed=0;const unregister=registerReminderRoute(root,'pet',{available:()=>true,consume:async(record)=>{consumed++;assert.equal(record.sessionKey,'pet:alice');}});
  try{assert.equal((await tickSessionReminders(root,at(2))).handled.length,1);assert.equal(consumed,1);}finally{unregister();}
}));
test('pagination retains start cursor until all pages; API uses bounded official history parameters',()=>setup(async(root,watch)=>{
  watch.write({...watch.read()!,historyId:'10'});let page=0;
  const app=service(root,url=>{
    if(url.pathname.endsWith('/profile'))return {emailAddress:'agent@test.com',historyId:'30'};
    assert.equal(url.searchParams.get('historyTypes'),'messageAdded');assert.equal(url.searchParams.get('labelId'),'INBOX');assert.equal(url.searchParams.get('startHistoryId'),'10');
    if(++page===1)return {historyId:'30',nextPageToken:'page2',history:[]};
    assert.equal(url.searchParams.get('pageToken'),'page2');return {historyId:'30',history:[]};
  });
  await tickGmailWatch(root,at(0),app);assert.equal(watch.read()!.historyId,'10');assert.equal(watch.read()!.pageToken,'page2');
  await tickGmailWatch(root,at(1),app);assert.equal(watch.read()!.historyId,'30');assert.equal(watch.read()!.pageToken,undefined);
}));
test('changed accounts and expired history never silently reset cursor',()=>setup(async(root,watch)=>{
  await tickGmailWatch(root,at(0),service(root,()=>({emailAddress:'agent@test.com',historyId:'10'})));
  await assert.rejects(tickGmailWatch(root,at(1),service(root,()=>({emailAddress:'other@test.com',historyId:'20'}))),/ACCOUNT_CHANGED/);assert.equal(watch.read()!.historyId,'10');
  const expired=new AgentConnectorService(root,{credentials:{configured:()=>true,token:async()=> 'secret'},fetcher:async(input)=>String(input).endsWith('/profile')?new Response('{"emailAddress":"agent@test.com","historyId":"30"}'):new Response('{}',{status:404})});
  await assert.rejects(tickGmailWatch(root,at(2),expired));assert.equal(watch.read()!.historyId,'10');
  watch.configure(owner,true,true);assert.equal(watch.read()!.historyId,undefined);
}));
test('failed Event admission retains cursor and never blindly repeats its consumer',()=>setup(async(root,watch)=>{
  watch.write({...watch.read()!,historyId:'10'});
  // Corrupt reminder state fails admission before any new check can be created.
  const reminders=new SessionReminderStore(root);const bad=await reminders.create(owner,{source:'agent',mode:'check',purpose:'test',dueAt:at(3).toISOString()},at(0));
  fs.writeFileSync(path.join(root,'data/reminders',bad.id+'.json'),'{}');
  const app=service(root,url=>url.pathname.endsWith('/profile')?{emailAddress:'agent@test.com',historyId:'20'}:{historyId:'20',history:[{id:'15',messagesAdded:[{message:{id:'m1'}}]}]});
  await assert.rejects(tickGmailWatch(root,at(0),app));assert.equal(watch.read()!.historyId,'10');
  fs.rmSync(path.join(root,'data/reminders',bad.id+'.json'));
  await assert.rejects(tickGmailWatch(root,at(1),app),/EVENT_REVIEW_REQUIRED/);assert.equal(reminders.list().length,0);
}));
