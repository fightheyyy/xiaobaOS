import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { SubAgentJournal } from '../src/core/sub-agent-journal';
import { SubAgentManager } from '../src/core/sub-agent-manager';
import { CheckSubagentTool } from '../src/tools/check-subagent-tool';
const rootFor=(fn:(root:string)=>Promise<void>)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'xiaoba-child-journal-'));return fn(root).finally(()=>fs.rmSync(root,{recursive:true,force:true}));};
test('actual killed child is inspectable only in original parent and never auto-runs',()=>rootFor(async root=>{
  const script=path.join(root,'child.cjs');
  fs.writeFileSync(script,`const {SubAgentJournal}=require(${JSON.stringify(path.resolve('dist/core/sub-agent-journal.js'))});new SubAgentJournal(${JSON.stringify(root)}).record('alice',{id:'sub-crashed',taskDescription:'review code',roleName:'EngineerCat',status:'waiting_for_input',createdAt:Date.now(),progressLog:['checked source'],pendingQuestion:'which branch?',outputFiles:['output/report.md']});process.send('ready');setInterval(()=>{},1000);`);
  const child=fork(script,[],{silent:true});
  await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(new Error('early exit')));});
  const journal=new SubAgentJournal(root);assert.equal(journal.list('alice').length,0);
  child.kill('SIGKILL');await new Promise<void>(r=>child.once('exit',()=>r()));
  const restored=new SubAgentJournal(root).list('alice');assert.equal(restored[0].status,'interrupted');assert.equal(restored[0].pendingQuestion,'which branch?');assert.match(restored[0].recoveryNote!,/不得盲目重放/);
  assert.equal(journal.list('bob').length,0);const manager=SubAgentManager.getInstance();assert.equal(manager.listByParent('alice',root)[0].status,'interrupted');
  assert.equal(manager.getInfoForParent('bob','sub-crashed',root),undefined);assert.equal(manager.resumeForParent('alice','sub-crashed','main'),'not_found');
  const output:any=await new CheckSubagentTool().execute({subagent_id:'sub-crashed'},{workingDirectory:root,conversationHistory:[],surface:'cli',sessionId:'alice'});assert.match(output.toolContent,/已中断/);
}));
test('journal bounds progress, retains terminal evidence and fails closed on corruption',()=>rootFor(async root=>{
  const journal=new SubAgentJournal(root),info={id:'sub-test',taskDescription:'test',status:'completed' as const,createdAt:Date.now(),completedAt:Date.now(),progressLog:Array.from({length:100},(_,i)=>String(i)),outputFiles:[]};
  journal.record('alice',info);assert.equal(journal.list('alice')[0].progressLog.length,50);assert.equal(journal.list('bob').length,0);
  journal.record('alice',{...info,completedAt:Date.now()-31*60*1000});assert.equal(journal.list('alice').length,0);
  const file=fs.readdirSync(path.join(root,'data/subagents'))[0];fs.writeFileSync(path.join(root,'data/subagents',file),'{}');assert.throws(()=>journal.list('alice'),/INVALID/);
}));
