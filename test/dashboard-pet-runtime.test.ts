import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadPetRuntime(): any {
  const runtimePath = path.join(process.cwd(), 'desktop', 'dashboard', 'pet-runtime.js');
  const context: any = { window: {} };
  vm.runInNewContext(fs.readFileSync(runtimePath, 'utf-8'), context, { filename: runtimePath });
  return context.window.XiaoBaPetRuntime;
}

describe('Dashboard pet runtime event handling', () => {
  test('channel_reply text events are delivered as separate assistant messages', () => {
    const runtime = loadPetRuntime();
    const messages: Array<{ text: string; mode: string }> = [];
    const handler = runtime.createEventHandler({
      setState: () => {},
      onText: (_event: any, text: string, meta: any) => messages.push({ text, mode: meta?.mode }),
    });

    handler({ type: 'user_message', text: '开始' });
    handler({ type: 'tool_start', name: 'send_text' });
    handler({ type: 'state', state: 'review', reason: 'channel_reply' });
    handler({ type: 'text', text: '第一段' });
    handler({ type: 'tool_end', name: 'send_text' });
    handler({ type: 'tool_start', name: 'send_text' });
    handler({ type: 'state', state: 'review', reason: 'channel_reply' });
    handler({ type: 'text', text: '第二段' });

    assert.deepStrictEqual(messages, [
      { text: '第一段', mode: 'message' },
      { text: '第二段', mode: 'message' },
    ]);
  });

  test('text_stream events remain cumulative for streaming drafts', () => {
    const runtime = loadPetRuntime();
    const messages: Array<{ text: string; mode: string }> = [];
    const handler = runtime.createEventHandler({
      setState: () => {},
      onText: (_event: any, text: string, meta: any) => messages.push({ text, mode: meta?.mode }),
    });

    handler({ type: 'user_message', text: 'stream' });
    handler({ type: 'state', state: 'review', reason: 'text_stream' });
    handler({ type: 'text', text: 'Hel' });
    handler({ type: 'text', text: 'lo' });

    assert.deepStrictEqual(messages, [
      { text: 'Hel', mode: 'stream' },
      { text: 'Hello', mode: 'stream' },
    ]);
  });

  test('done events report when text was already rendered in the same turn', () => {
    const runtime = loadPetRuntime();
    const doneEvents: Array<{ text: string; alreadyRenderedText: boolean }> = [];
    const handler = runtime.createEventHandler({
      setState: () => {},
      onText: () => {},
      onDone: (event: any, meta: any) => doneEvents.push({
        text: event.text,
        alreadyRenderedText: meta?.alreadyRenderedText === true,
      }),
    });

    handler({ type: 'user_message', text: 'hello' });
    handler({ type: 'state', state: 'review', reason: 'channel_reply' });
    handler({ type: 'text', text: '模型服务连续不可用，已停止继续请求。请稍后再试，或者切换模型/provider。' });
    handler({
      type: 'done',
      text: '模型服务连续不可用，已停止继续请求。请稍后再试，或者切换模型/provider。',
      visibleToUser: true,
    });

    assert.deepStrictEqual(doneEvents, [{
      text: '模型服务连续不可用，已停止继续请求。请稍后再试，或者切换模型/provider。',
      alreadyRenderedText: true,
    }]);
  });
});

describe('Dashboard pet page wiring', () => {
  test('main dashboard chat passes role-scoped session keys to event replay and sends', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'index.html'), 'utf-8');

    assert.match(index, /function roleScopedSessionKey\(petId, roleKey\)/);
    assert.match(index, /selectedSessionKey = roleScopedSessionKey\(selectedPetId, selectedPetRole\);/);
    assert.match(index, /petClient\.connect\(selectedPetId, handlePetEvent, \{ replay: true, sessionKey: selectedSessionKey \}\)/);
    assert.match(index, /petClient\.sendMessage\(selectedPetId, text, petEventSource \? undefined : handlePetEvent, \{ source: 'dashboard', sessionKey: selectedSessionKey \}\)/);
  });

  test('main dashboard chat renders message-mode text as separate visible replies', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'index.html'), 'utf-8');

    assert.match(index, /onText: \(_event, text, meta\) => \{\s*renderAssistantText\(text, meta\);/);
    assert.match(index, /onDone: \(event, meta\) => \{\s*if \(event\.visibleToUser !== false && event\.text && !meta\?\.alreadyRenderedText\) \{/);
    assert.match(index, /if \(meta\.mode === 'message'\) \{\s*appendPetBubble\('assistant', value\);\s*currentAssistantBubble = null;\s*return;\s*\}/);
    assert.doesNotMatch(index, /function renderToolStart\(event\) \{\s*discardAssistantDraft\(\);/);
  });

  test('desktop pet widget does not repeat done text after a text event', () => {
    const widget = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'pet-widget.html'), 'utf-8');

    assert.match(widget, /onDone: \(event, meta\) => \{\s*if \(event\.text && !meta\?\.alreadyRenderedText\) showNotice\(event\.text, 5200\);/);
  });

  test('skills page renders card names through the dashboard display-name helper', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'index.html'), 'utf-8');

    assert.match(index, /function getSkillDisplayName\(skill\) \{/);
    assert.match(index, /const displayName = getSkillDisplayName\(sk\);/);
    assert.match(index, /const displayName = getSkillDisplayName\(i\);/);
    const renderedNameFragments = index.match(/<div class="skill-name" title="'\+escapeHtml\(displayName\)\+'">'\+escapeHtml\(displayName\)/g) || [];
    assert.ok(renderedNameFragments.length >= 2);
  });

  test('capability cards expose package selection or deletion without lifecycle actions', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'index.html'), 'utf-8');

    assert.match(index, /onclick="activateRole/);
    assert.match(index, /onclick="deleteRole/);
    assert.match(index, /onclick="deleteSkill/);
    assert.doesNotMatch(index, /changeSkillLifecycle/);
    assert.doesNotMatch(index, /changeRoleLifecycle/);
    assert.doesNotMatch(index, /unblockToCandidate|promoteToActive|tryCandidate|blockCapability/);
  });

  test('config page does not expose legacy Inspector settings', () => {
    const index = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'index.html'), 'utf-8');

    assert.doesNotMatch(index, /title:'Inspector'/);
    assert.doesNotMatch(index, /INSPECTOR_SERVER_/);
    assert.doesNotMatch(index, /XIAOBA_INSPECTOR_/);
    assert.doesNotMatch(index, /MYSQL_DATABASE/);
  });
});
