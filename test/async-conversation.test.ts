import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MessageSessionManager } from '../src/core/message-session-manager';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { AgentSession } from '../src/core/agent-session';
import { ToolManager } from '../src/tools/tool-manager';
import { Logger } from '../src/utils/logger';
import { cancellationError } from '../src/utils/cancellation';
const skills={loadSkills:async()=>{},getAllSkills:()=>[],getUserInvocableSkills:()=>[],getSkill:()=>undefined,findAutoInvocableSkillByText:()=>undefined};
const defer=<T=void>()=>{let resolve!:(value:T)=>void;let reject!:(error:any)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function scoped(action:(root:string)=>Promise<void>){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-async-')),cwd=process.cwd();process.chdir(root);Logger.setSilentMode(true);try{await action(root);}finally{process.chdir(cwd);Logger.setSilentMode(false);fs.rmSync(root,{recursive:true,force:true});}}
const yieldTurn=()=>new Promise<void>(r=>setImmediate(r));

test('intervening messages refresh the live route without losing a running child completion',()=>scoped(async root=>{
 const manager=SubAgentManager.getInstance(),key=randomUUID(),owner={},started=defer(),done=defer<any>(),notified=defer<string>();let oldCalls=0;
 const ai={chatStream:async()=>{started.resolve();return done.promise;}};
 manager.refreshPlatformCallbacks(key,{injectMessage:async()=>{oldCalls++;}},owner);
 const child=manager.spawn(key,undefined,'work','work',root,ai as any,skills as any);assert.ok(!('error' in child));await started.promise;
 manager.refreshPlatformCallbacks(key,{injectMessage:async text=>{notified.resolve(text);}},owner);done.resolve({content:'finished'});
 assert.match(await notified.promise,/finished/);assert.equal(oldCalls,0);manager.unregisterPlatformCallbacksForOwner(key,owner);
}));
test('a replacement lifecycle does not receive old child completion; old cleanup preserves new owner',()=>scoped(async root=>{
 const manager=SubAgentManager.getInstance(),key=randomUUID(),first={},second={},started=defer(),done=defer<any>();let calls=0;
 manager.refreshPlatformCallbacks(key,{injectMessage:async()=>{calls++;}},first);
 const child=manager.spawn(key,undefined,'work','work',root,{chatStream:async()=>{started.resolve();return done.promise;}} as any,skills as any);assert.ok(!('error' in child));await started.promise;
 manager.refreshPlatformCallbacks(key,{injectMessage:async()=>{calls++;}},second);manager.unregisterPlatformCallbacksForOwner(key,first);done.resolve({content:'old work'});
 await yieldTurn();await yieldTurn();assert.equal(calls,0);
 const notified=defer();manager.refreshPlatformCallbacks(key,{injectMessage:async()=>{notified.resolve();}},second);
 const next=manager.spawn(key,undefined,'new work','work',root,{chatStream:async()=>({content:'new'})} as any,skills as any);assert.ok(!('error' in next));await notified.promise;manager.unregisterPlatformCallbacksForOwner(key,second);
}));
test('busy feedback waits for actual idle, remains ordered and does not block another session',()=>scoped(async root=>{
 const started=defer(),answer=defer<any>();const ai={chatStream:async()=>{started.resolve();return answer.promise;}};
 const manager=new MessageSessionManager({aiService:ai as any,skillManager:skills as any,toolManager:new ToolManager(root)},'pet');
 try{
  const session=manager.getOrCreate('pet:alice');const running=session.handleMessage('work',{surface:'pet'});await started.promise;
  const order:string[]=[];const one=manager.enqueueTurn('pet:alice','alice',async()=>{order.push('one');});const two=manager.enqueueTurn('pet:alice','alice',async()=>{order.push('two');});
  await manager.enqueueTurn('pet:bob','bob',async()=>{order.push('bob');});assert.deepEqual(order,['bob']);
  answer.resolve({content:'done'});await running;await Promise.all([one,two]);assert.deepEqual(order,['bob','one','two']);
 }finally{await manager.destroy();}
}));
test('shutdown cancels idle wait and queued feedback without late delivery',()=>scoped(async root=>{
 const started=defer();const ai={chatStream:async(_m:any,_t:any,_c:any,options:any)=>new Promise((_resolve,reject)=>{options.abortSignal.addEventListener('abort',()=>reject(cancellationError()),{once:true});started.resolve();})};
 const manager=new MessageSessionManager({aiService:ai as any,skillManager:skills as any,toolManager:new ToolManager(root)},'pet');
 const session=manager.getOrCreate('pet:shutdown');const running=session.handleMessage('work',{surface:'pet'});await started.promise;let calls=0;
 const queued=manager.enqueueTurn(session.key,'shutdown',async()=>{calls++;});await yieldTurn();await manager.destroy();await running;await queued;assert.equal(calls,0);
 await manager.enqueueTurn(session.key,'shutdown',async()=>{calls++;});assert.equal(calls,0);
}));
test('failed feedback does not poison later queued results',()=>scoped(async root=>{
 const manager=new MessageSessionManager({aiService:{chatStream:async()=>({content:'done'})} as any,skillManager:skills as any,toolManager:new ToolManager(root)},'pet');
 try {let delivered=0;const bad=manager.enqueueTurn('pet:alice','alice',async()=>{throw new Error('delivery failed');});const checked=assert.rejects(bad,/delivery failed/);
  const next=manager.enqueueTurn('pet:alice','alice',async()=>{delivered++;});await checked;await next;assert.equal(delivered,1);
 }finally{await manager.destroy();}
}));
test('internal completion cannot approve a consequential tool through the actual main session',()=>scoped(async root=>{
 const tools=new ToolManager(root);let writes=0;tools.registerTool({definition:{name:'danger_confirmed',description:'test',requiresConfirmation:true,parameters:{type:'object',properties:{}}},execute:async()=>{writes++;return 'done';}});
 const seen:any[]=[];let calls=0;const ai={chatStream:async(messages:any[])=>{seen.push(messages.map(m=>({...m})));return ++calls===1?{toolCalls:[{id:'call',type:'function',function:{name:'danger_confirmed',arguments:'{}'}}]}:{content:''};}};
 const session=new AgentSession('pet:internal',{aiService:ai as any,skillManager:skills as any,toolManager:tools},'pet');
 await session.handleMessage('确认，执行',{surface:'pet',internal:true});assert.equal(writes,0);
 assert.ok(seen[0].some(m=>m.role==='user'&&m.content==='确认，执行'&&m.__injected));
}));

test('real main loop acknowledges, dispatches, keeps chatting and later delivers the child result',()=>scoped(async root=>{
 const childStarted=defer(),childAnswer=defer<any>(),delivered=defer();const visible:string[]=[];let responseIndex=0,feedback:Promise<void>|undefined;
 const call=(name:string,args:any)=>({content:null,toolCalls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const responses=[call('send_text',{text:'我看看这段代码。'}),call('spawn_subagent',{task_description:'检查代码',user_message:'检查代码并报告结果'}),{content:''},call('send_text',{text:'在呢，代码还在看。'}),{content:''},call('send_text',{text:'看完了，问题在边界条件。'}),{content:''}];
 const ai={chatStream:async()=>{const response=responses[responseIndex++];if(!response)throw new Error('unexpected extra model call');return response;}};
 const tools=new ToolManager(root,{subAgentServiceFactory:async()=>({aiService:{chatStream:async()=>{childStarted.resolve();return childAnswer.promise;}} as any,skillManager:skills as any})});
 const manager=new MessageSessionManager({aiService:ai as any,skillManager:skills as any,toolManager:tools},'pet');
 const session=manager.getOrCreate('pet:talk');
 const channel={chatId:'talk',reply:async(_id:string,text:string)=>{visible.push(text);if(text==='看完了，问题在边界条件。')delivered.resolve();},sendFile:async()=>{}};
 const route=()=>SubAgentManager.getInstance().refreshPlatformCallbacks(session.key,{injectMessage:async text=>{feedback=manager.enqueueTurn(session.key,'talk',async current=>{await current.handleMessage(text,{surface:'pet',channel,internal:true});});await feedback;}},manager);
 try{
  route();await session.handleMessage('帮我看看代码',{surface:'pet',channel});await childStarted.promise;assert.equal(session.isBusy(),false);
  assert.equal(SubAgentManager.getInstance().listByParent(session.key,root)[0].status,'running');
  route();await session.handleMessage('你还在吗',{surface:'pet',channel});assert.deepEqual(visible,['我看看这段代码。','在呢，代码还在看。']);
  childAnswer.resolve({content:'问题在边界条件。'});await delivered.promise;await feedback;
  assert.deepEqual(visible,['我看看这段代码。','在呢，代码还在看。','看完了，问题在边界条件。']);assert.equal(responseIndex,7);
 }finally{await manager.destroy();}
}));
