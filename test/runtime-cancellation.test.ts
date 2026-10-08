import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AIService } from '../src/utils/ai-service';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { OllamaProvider } from '../src/providers/ollama-provider';
import { AnthropicProvider } from '../src/providers/anthropic-provider';
import { ConversationRunner } from '../src/core/conversation-runner';
import { AgentSession } from '../src/core/agent-session';
import { ToolManager } from '../src/tools/tool-manager';
import { Logger } from '../src/utils/logger';
import { isCancellation } from '../src/utils/cancellation';

for (const Provider of [OpenAIProvider, OllamaProvider, AnthropicProvider]) {
  for (const stream of [false, true]) test(`${Provider.name} physically cancels ${stream ? 'stream' : 'HTTP'} and closes connection`, async () => {
    let requested!: () => void, disconnected!: () => void;
    const started = new Promise<void>(r => requested = r), closed = new Promise<void>(r => disconnected = r);
    const server = http.createServer((_req, res) => {
      res.on('close', disconnected);
      if (stream) {
        res.writeHead(200, { 'content-type': Provider === OllamaProvider ? 'application/x-ndjson' : 'text/event-stream' });
        res.write(Provider === OllamaProvider ? '{"message":{"content":"hello"}}\n' : ': keepalive\n\n');
      }
      requested();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const address = server.address() as any;
      const provider = new Provider({ apiKey: 'test-key', apiUrl: `http://127.0.0.1:${address.port}`, model: 'test' });
      const controller = new AbortController();
      const call = stream ? provider.chatStream([{role:'user',content:'test'}], undefined, {}, {abortSignal:controller.signal})
        : provider.chat([{role:'user',content:'test'}], undefined, {abortSignal:controller.signal});
      const rejected = assert.rejects(call, error => isCancellation(error));
      await started; controller.abort(); await rejected; await closed;
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
}

test('AIService stops Retry-After wait and never switches to backup even with force-failover', async () => {
  const service = new AIService({ provider:'openai',apiKey:'test',apiUrl:'http://localhost',model:'test' });
  const controller = new AbortController(); let calls = 0, backups = 0;
  (service as any).providerChain = [
    {label:'primary',config:{apiKey:'test',provider:'openai'},provider:{chat:async () => { calls++; setImmediate(() => controller.abort()); throw {response:{status:429,headers:{'retry-after':'60'}}}; }}},
    {label:'backup',config:{apiKey:'test',provider:'openai'},provider:{chat:async () => {backups++;return {content:'bad'};}}},
  ];
  const before = process.env.XIAOBA_LLM_FAILOVER_ON_ANY_ERROR;
  process.env.XIAOBA_LLM_FAILOVER_ON_ANY_ERROR = 'true';
  try { await assert.rejects(service.chat([],undefined,{abortSignal:controller.signal}), isCancellation); assert.equal(calls,1); assert.equal(backups,0); }
  finally { if (before === undefined) delete process.env.XIAOBA_LLM_FAILOVER_ON_ANY_ERROR; else process.env.XIAOBA_LLM_FAILOVER_ON_ANY_ERROR = before; }
});

test('tool backoff cancellation closes transcript without retry or another model call', async () => {
  const controller = new AbortController(); let calls = 0;
  const ai = {chat:async () => ({toolCalls:[{id:'call-1',type:'function',function:{name:'read',arguments:'{}'}}]})};
  const tools = {getToolDefinitions:()=>[],executeTool:async () => {calls++; setImmediate(() => controller.abort()); return {tool_call_id:'call-1',name:'read',content:'try later',status:'failure',retryable:true};}};
  const runner = new ConversationRunner(ai as any,tools as any,{stream:false,enableCompression:false,toolExecutionContext:{abortSignal:controller.signal}});
  const result = await runner.run([{role:'user',content:'test'}]);
  assert.equal(calls,1); assert.equal(result.toolResults[0].result.status,'cancelled');
  assert.equal(result.messages.filter(m => m.role === 'tool').length,1);
});

test('main-session interrupt reaches provider; next request receives a fresh signal', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-cancel-')); const cwd=process.cwd(); process.chdir(root); Logger.setSilentMode(true);
  let started!: () => void; const ready=new Promise<void>(r => started=r); let calls=0;
  const ai = { chatStream: async (_m:any,_t:any,_c:any,options:any) => {
    calls++; if(calls>1) { assert.equal(options.abortSignal.aborted,false);return {content:'ready'}; }
    return new Promise((_resolve,reject) => { options.abortSignal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}); started(); });
  }};
  const skills = {loadSkills:async()=>{},getUserInvocableSkills:()=>[],getSkill:()=>undefined,getAllSkills:()=>[],findAutoInvocableSkillByText:()=>undefined};
  try {
    const session=new AgentSession('cli:cancel',{aiService:ai as any,skillManager:skills as any,toolManager:new ToolManager(root)},'cli');
    const running=session.handleMessage('work',{surface:'cli'}); await ready; session.requestInterrupt();
    const result=await running; assert.equal(result.visibleToUser,false); assert.equal(result.failed,true); assert.equal(session.isBusy(),false);
    assert.equal((await session.handleMessage('again',{surface:'cli'})).text,'ready');
  } finally {process.chdir(cwd);Logger.setSilentMode(false);fs.rmSync(root,{recursive:true,force:true});}
});

test('cancellation after a completed effect preserves tool results and suppresses late model text', async()=>{
  const controller=new AbortController();let modelCalls=0;
  const ai={chat:async()=>{if(++modelCalls===1)return {toolCalls:[{id:'effect',type:'function',function:{name:'effect',arguments:'{}'}}]};controller.abort();return {content:'late reply'};}};
  const tools={getToolDefinitions:()=>[],executeTool:async()=>({tool_call_id:'effect',name:'effect',content:'sent, receipt=123',status:'success',ok:true})};
  const runner=new ConversationRunner(ai as any,tools as any,{stream:false,enableCompression:false,toolExecutionContext:{abortSignal:controller.signal}});
  const result=await runner.run([{role:'user',content:'send'}]);
  assert.equal(result.cancelled,true);assert.equal(result.finalResponseVisible,false);assert.equal(result.response,'');
  assert.equal(result.toolResults.length,1);assert.equal(result.toolResults[0].result.status,'success');assert.ok(result.messages.some(m=>m.role==='tool'&&String(m.content).includes('receipt=123')));
});

test('reused provider call IDs in different requests have distinct trusted action scopes',async()=>{
  let calls=0;const scopes:string[]=[];
  const ai={chat:async()=>++calls%2?{toolCalls:[{id:'ollama_tool_1_0',type:'function',function:{name:'write',arguments:'{}'}}]}:{content:'done'}};
  const tools={getToolDefinitions:()=>[],executeTool:async(_call:any,_history:any,context:any)=>{scopes.push(context.runId);return {tool_call_id:'ollama_tool_1_0',name:'write',status:'success',content:'done'};}};
  const runner=new ConversationRunner(ai as any,tools as any,{stream:false,enableCompression:false});
  await runner.run([{role:'user',content:'first confirmed intent'}]);await runner.run([{role:'user',content:'second confirmed intent'}]);
  assert.equal(scopes.length,2);assert.ok(scopes[0]);assert.notEqual(scopes[0],scopes[1]);
});
