import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadPetRuntime(): any {
  const dataPath = path.join(process.cwd(), 'desktop', 'dashboard', 'grokbot-data.js');
  const runtimePath = path.join(process.cwd(), 'desktop', 'dashboard', 'pet-runtime.js');
  const context: any = { window: {} };
  vm.runInNewContext(fs.readFileSync(dataPath, 'utf-8'), context, { filename: dataPath });
  vm.runInNewContext(fs.readFileSync(runtimePath, 'utf-8'), context, { filename: runtimePath });
  return context.window.XiaoBaPetRuntime;
}

describe('Dashboard procedural XiaoBa renderer', () => {
  test('ships the black-gold base and a distinct color for every default role', () => {
    const runtime = loadPetRuntime();
    const petDir = path.join(process.cwd(), 'desktop', 'dashboard', 'pets', 'xiaoba');
    const manifest = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf-8'));
    const roleKeys = [
      'base',
      'user-cat',
      'inspector-cat',
      'reviewer-cat',
      'engineer-cat',
      'browser-cat',
      'gui-cat',
      'secretary-cat',
      'evolution-cat',
    ];

    assert.strictEqual(runtime.rendererName, 'grok-cat-v1');
    assert.deepStrictEqual(Object.keys(runtime.defaultRoleThemes), roleKeys);
    assert.strictEqual(runtime.defaultRoleThemes.base.body, '#17140F');
    assert.strictEqual(runtime.defaultRoleThemes.base.eyes, '#E5B94F');
    assert.strictEqual(runtime.defaultRoleThemes.base.outline, '#C79A3B');
    assert.strictEqual(new Set(roleKeys.map(key => runtime.defaultRoleThemes[key].body)).size, roleKeys.length);
    assert.strictEqual(manifest.renderer, runtime.rendererName);
    assert.deepStrictEqual(manifest.roleThemes, JSON.parse(JSON.stringify(runtime.defaultRoleThemes)));
    assert.strictEqual(manifest.spritesheetPath, undefined);
    assert.strictEqual(fs.existsSync(path.join(petDir, 'spritesheet.webp')), false);
    const bundledPetIds = fs.readdirSync(path.dirname(petDir), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    assert.deepStrictEqual(bundledPetIds, ['xiaoba']);
  });

  test('normalizes manifest color overrides and keeps invalid colors out', () => {
    const runtime = loadPetRuntime();
    const theme = runtime.getRoleTheme('GUI CAT', {
      'gui-cat': { body: '#abc', eyes: '#102030', outline: 'not-a-color' },
    });

    assert.strictEqual(theme.role, 'gui-cat');
    assert.strictEqual(theme.body, '#AABBCC');
    assert.strictEqual(theme.eyes, '#102030');
    assert.strictEqual(theme.outline, null);
  });

  test('allocates deterministic non-repeating colors across the full custom-role capacity', () => {
    const runtime = loadPetRuntime();
    const customRoles = Array.from(
      { length: runtime.customRolePaletteCapacity },
      (_value, index) => `custom-role-${String(index).padStart(5, '0')}`,
    );
    const roleKeys = [...Object.keys(runtime.defaultRoleThemes), ...customRoles];
    const first = runtime.buildUniqueRoleThemes(roleKeys, runtime.defaultRoleThemes);
    const second = runtime.buildUniqueRoleThemes([...roleKeys].reverse(), runtime.defaultRoleThemes);
    const bodies = roleKeys.map(role => first[role].body);

    assert.strictEqual(new Set(bodies).size, roleKeys.length);
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    for (const role of Object.keys(runtime.defaultRoleThemes)) {
      assert.strictEqual(first[role].body, runtime.defaultRoleThemes[role].body);
    }
    for (const role of customRoles) {
      assert.notStrictEqual(first[role].body, runtime.defaultRoleThemes.base.body);
    }
    assert.throws(
      () => runtime.buildUniqueRoleThemes([...customRoles, 'one-role-too-many']),
      /custom role color palette exhausted/,
    );
  });

  test('reassigns custom manifest colors that collide with defaults or another role', () => {
    const runtime = loadPetRuntime();
    const themes = runtime.buildUniqueRoleThemes(
      ['custom-black', 'custom-first', 'custom-second'],
      {
        ...runtime.defaultRoleThemes,
        'custom-black': { body: '#17140f' },
        'custom-first': { body: '#abc' },
        'custom-second': { body: '#AABBCC' },
      },
    );
    const bodies = Object.values(themes).map((theme: any) => theme.body);

    assert.strictEqual(new Set(bodies).size, bodies.length);
    assert.notStrictEqual(themes['custom-black'].body, runtime.defaultRoleThemes.base.body);
    assert.strictEqual(themes['custom-first'].body, '#AABBCC');
    assert.notStrictEqual(themes['custom-second'].body, '#AABBCC');
  });

  test('keeps punctuation and Unicode role keys distinct and fails closed on canonical collisions', () => {
    const runtime = loadPetRuntime();
    const themes = runtime.buildUniqueRoleThemes(['role.one', 'role-one', '夜猫']);

    assert.ok(themes['role.one']);
    assert.ok(themes['role-one']);
    assert.ok(themes['夜猫']);
    assert.strictEqual(new Set([
      themes['role.one'].body,
      themes['role-one'].body,
      themes['夜猫'].body,
    ]).size, 3);
    assert.throws(
      () => runtime.buildUniqueRoleThemes(['custom role', 'custom_role']),
      /role keys collide after normalization/,
    );
  });

  test('bundles the complete GrokBot expression and state data', () => {
    const dataPath = path.join(process.cwd(), 'desktop', 'dashboard', 'grokbot-data.js');
    const context: any = { window: {} };
    vm.runInNewContext(fs.readFileSync(dataPath, 'utf-8'), context, { filename: dataPath });

    assert.strictEqual(context.window.XiaoBaGrokBotData.expressions.length, 25);
    assert.strictEqual(Object.keys(context.window.XiaoBaGrokBotData.shapes).length, 18);
    assert.strictEqual(Object.keys(context.window.XiaoBaGrokBotData.expressionStates).length, 39);
  });
});

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

  test('both pet pages load the shared procedural renderer before using the manifest', () => {
    const runtimeSource = fs.readFileSync(
      path.join(process.cwd(), 'desktop', 'dashboard', 'pet-runtime.js'),
      'utf-8',
    );
    const widget = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'pet-widget.html'), 'utf-8');
    const page = fs.readFileSync(path.join(process.cwd(), 'desktop', 'dashboard', 'pet.html'), 'utf-8');

    for (const html of [widget, page]) {
      assert.ok(html.indexOf('/grokbot-data.js') < html.indexOf('/pet-runtime.js'));
      assert.doesNotMatch(html, /image-rendering:\s*pixelated/);
    }
    assert.doesNotMatch(runtimeSource, /SpritePlayer|spritesheet|spriteUrl|\.drawImage\(|new Image\(/);
    assert.match(widget, /new XiaoBaPetRuntime\.PetPlayer\(sprite\)/);
    assert.match(widget, /buildUniqueRoleThemes\(data\.roleKeys, pet\.roleThemes\)/);
    assert.match(widget, /\}, \{ role: activeRole \}\)/);
    assert.match(page, /new XiaoBaPetRuntime\.PetPlayer\(sprite\)/);
    assert.match(page, /buildUniqueRoleThemes\(\s*petRoleKeys\.concat\(selectedPetRole \|\| 'base'\),\s*pet\.roleThemes/);
    assert.match(page, /\}, \{ role: selectedPetRole \}\)/);
    assert.doesNotMatch(page, /spriteAtlas|function drawFrame|\.drawImage\(/);
  });

  test('dashboard role avatars and brand use the shared procedural XiaoBa renderer', () => {
    const dashboardDir = path.join(process.cwd(), 'desktop', 'dashboard');
    const index = fs.readFileSync(path.join(dashboardDir, 'index.html'), 'utf-8');
    const runtime = fs.readFileSync(path.join(dashboardDir, 'pet-runtime.js'), 'utf-8');

    assert.ok(index.indexOf('grokbot-data.js') < index.indexOf('pet-runtime.js'));
    assert.match(index, /data-xiaoba-role-avatar="base"/);
    assert.match(index, /function hydrateRoleAvatars\(root = document\)/);
    assert.match(index, /function setDashboardRoleInventory\(roleKeys\)/);
    assert.match(index, /XiaoBaPetRuntime\.buildUniqueRoleThemes\(/);
    assert.match(index, /setDashboardRoleInventory\(roles\.map\(role => role\.name\)\)/);
    assert.match(index, /player\.load\(dashboardAvatarManifest, \{ role, autoplay: false \}\)/);
    assert.match(runtime, /if \(options\.autoplay !== false\)/);
    assert.doesNotMatch(index, /cat-icon\d*\.png|role-icons\/|roleAvatars|getRoleAvatar/);

    for (const staleAsset of [
      'cat-icon.png',
      'cat-icon1.png',
      'role-icons/engineer-cat.png',
      'role-icons/inspector-cat.png',
      'role-icons/researcher-cat.png',
      'role-icons/reviewer-cat.png',
    ]) {
      assert.strictEqual(fs.existsSync(path.join(dashboardDir, staleAsset)), false, staleAsset);
    }
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
