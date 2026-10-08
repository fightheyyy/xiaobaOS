(function () {
  'use strict';
  const names = { gmail: 'Gmail', notion: 'Notion', github: 'GitHub' };
  const icons = {
    gmail: '<svg viewBox="0 0 32 24" aria-hidden="true"><path fill="#4285f4" d="M0 5v16c0 1.7 1.3 3 3 3h3V9z"/><path fill="#34a853" d="M26 9v15h3c1.7 0 3-1.3 3-3V5z"/><path fill="#ea4335" d="M6 9l10 7.5L26 9V1l-10 12L6 1z"/><path fill="#c5221f" d="M0 5V3C0 .5 2.8-.9 4.8.6L6 1v8z"/><path fill="#fbbc04" d="M26 1l1.2-.4C29.2-.9 32 .5 32 3v2l-6 4z"/></svg>',
    notion: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="3" fill="white" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="M8 9h6l8 12V11h-2V9h6v2h-2v14h-4L12 13v10h2v2H8v-2h2V11H8z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.14c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.73.8 1.18 1.83 1.18 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.13v3.18c0 .31.21.68.79.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>',
  };
  const copy = {
    en: {
      title: 'Connectors', connect: 'Connect', reconnect: 'Reconnect', disconnect: 'Disconnect', missing: 'Not connected', configured: 'Configured', connected: 'Connected',
      gmail: 'Let your agent read and send mail.', notion: 'Let your agent read and update notes.', github: 'Let your agent work with repositories and issues.',
      token: 'Access token', clientId: 'Google client ID', clientSecret: 'Google client secret', setup: 'Google client settings', authorize: 'Continue with Google', save: 'Connect account',
      githubHelp: 'Create a personal access token for the agent’s GitHub account.', notionHelp: 'Create a Notion integration and connect it to the pages your agent will use.',
      googleHelp: 'Enable Gmail API and configure your Google OAuth client. For a web client, register this redirect URL:', tokenLink: 'Get a token', notionLink: 'Open integrations',
      keep: 'Leave saved client fields empty to keep them.', done: 'Account connected.', authOpened: 'Complete authorization in your browser, then return here.',
      authFailed: 'Google authorization did not complete. Please try again.', failed: 'Connection failed.', disconnectQuestion: 'Disconnect this account?', empty: 'Enter an access token.', close: 'Close', loading: 'Loading…',
    },
    zh: {
      title: '应用连接', connect: '连接', reconnect: '重新授权', disconnect: '断开连接', missing: '未连接', configured: '已配置', connected: '已连接',
      gmail: '让 Agent 读取和发送邮件。', notion: '让 Agent 读取和整理笔记。', github: '让 Agent 处理仓库和 Issue。',
      token: '访问 Token', clientId: 'Google 客户端 ID', clientSecret: 'Google 客户端密钥', setup: 'Google 客户端设置', authorize: '通过 Google 授权', save: '连接账号',
      githubHelp: '为 Agent 的 GitHub 账号创建 Personal Access Token。', notionHelp: '创建 Notion integration，并将需要使用的页面连接到它。',
      googleHelp: '启用 Gmail API 并配置 Google OAuth 客户端。网页客户端需登记这个回调地址：', tokenLink: '获取 Token', notionLink: '打开 Integrations',
      keep: '已保存的客户端字段留空即可保留。', done: '账号已连接。', authOpened: '请在浏览器完成授权，再返回这里。',
      authFailed: 'Google 授权未完成，请重试。', failed: '连接失败。', disconnectQuestion: '断开这个账号的连接？', empty: '请填写访问 Token。', close: '关闭', loading: '正在加载…',
    },
  };
  let state = null, language = () => 'en', activeApp = null, busy = false, externalAuthorization = false;
  const accounts = {};
  const text = key => (copy[language()] || copy.en)[key] || key;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const modal = () => document.getElementById('connector-modal');
  function notice(message, error = false) {
    const target = document.getElementById(activeApp ? 'connector-form-notice' : 'connector-notice');
    target.textContent = message; target.classList.toggle('error', error);
  }
  async function request(path, method = 'GET', data = {}) {
    const response = await fetch('/api/connectors' + path, { method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Xiaoba-Connector-Admin': '1' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || text('failed')); return result;
  }
  function render() {
    document.getElementById('connector-heading').textContent = text('title');
    if (!state) return;
    document.getElementById('connector-cards').innerHTML = state.connections.map(connection => {
      const app = connection.app, ready = connection.configured && connection.enabled;
      const status = ready ? (accounts[app] ? 'connected' : 'configured') : 'missing';
      return '<article class="skill-card connector-card" data-connector="' + app + '"><div class="skill-header"><div class="connector-mark">' + icons[app] + '</div><div class="skill-title-block"><div class="skill-name">' + names[app] + '</div></div><span class="tag ' + (ready ? 'green' : 'gray') + '">' + escape(text(status)) + '</span></div>' +
        '<div class="skill-desc">' + escape(text(app)) + '</div>' + (ready && accounts[app] ? '<div class="skill-files">' + escape(accounts[app]) + '</div>' : '') +
        '<div class="skill-actions"><button type="button" class="btn btn-primary" data-connector-connect="' + app + '">' + escape(text(ready ? 'reconnect' : 'connect')) + '</button>' +
        (ready ? '<button type="button" class="btn" data-connector-disconnect="' + app + '">' + escape(text('disconnect')) + '</button>' : '') + '</div></article>';
    }).join('');
  }
  async function verify(app) {
    const result = await request('/' + app + '/verify', 'POST'), account = result.account;
    accounts[app] = account.emailAddress || account.login || account.name || account.bot?.owner?.user?.name || account.id || names[app];
  }
  async function load() {
    try {
      state = await request(''); render();
      if (externalAuthorization && state.connections.some(item => item.app === 'gmail' && item.enabled && item.configured)) { await verify('gmail'); render(); }
    } catch (error) { notice(error.message, true); }
  }
  function field(name, label, type = 'password', required = false) {
    return '<div class="config-row"><label class="config-label" for="connector-' + name + '">' + escape(label) + '</label><input class="config-input" id="connector-' + name + '" name="' + name + '" type="' + type + '" autocomplete="off" spellcheck="false" maxlength="16000"' + (required ? ' required' : '') + '></div>';
  }
  function open(app) {
    activeApp = app;
    document.getElementById('connector-modal-title').textContent = names[app];
    document.getElementById('connector-modal-close').setAttribute('aria-label', text('close'));
    const googleReady = state.gmailClientConfigured;
    const fields = app === 'gmail'
      ? '<details class="connector-client-settings"' + (googleReady ? '' : ' open') + '><summary>' + escape(text('setup')) + '</summary>' + field('clientId', text('clientId'), 'text', !googleReady) + field('clientSecret', text('clientSecret'), 'password', !googleReady) +
        '<p class="connector-help">' + escape(text('googleHelp')) + '</p><code class="connector-redirect">' + escape(location.origin + '/api/connectors/gmail/oauth/callback') + '</code>' + (googleReady ? '<p class="connector-help">' + escape(text('keep')) + '</p>' : '') + '</details>'
      : '<p class="connector-help">' + escape(text(app + 'Help')) + ' <a href="' + (app === 'github' ? 'https://github.com/settings/personal-access-tokens' : 'https://www.notion.so/profile/integrations') + '" target="_blank" rel="noopener noreferrer">' + escape(text(app === 'github' ? 'tokenLink' : 'notionLink')) + ' ↗</a></p>' + field('token', text('token'), 'password', true);
    document.getElementById('connector-auth-form').innerHTML = fields + '<p id="connector-form-notice" class="connector-notice" role="status" aria-live="polite"></p><div class="skill-actions"><button type="submit" class="btn btn-primary">' + escape(text(app === 'gmail' ? 'authorize' : 'save')) + '</button></div>';
    modal().classList.add('show');
    document.getElementById('connector-auth-form').querySelector('input')?.focus();
  }
  function close() {
    modal().classList.remove('show'); document.getElementById('connector-auth-form').replaceChildren();
    const app = activeApp; activeApp = null;
    document.querySelector('[data-connector-connect="' + app + '"]')?.focus();
  }
  async function safely(action, button) {
    if (busy) return; busy = true; if (button) button.disabled = true;
    try { await action(); } catch (error) { notice(error.message, true); } finally { busy = false; if (button?.isConnected) button.disabled = false; }
  }
  function init(options) {
    language = options.getLanguage;
    document.getElementById('page-connectors').addEventListener('click', event => {
      const connect = event.target.closest('[data-connector-connect]'), disconnect = event.target.closest('[data-connector-disconnect]');
      if (connect) open(connect.dataset.connectorConnect);
      if (disconnect && confirm(text('disconnectQuestion'))) void safely(async () => {
        const app = disconnect.dataset.connectorDisconnect; await request('/' + app + '/credentials', 'DELETE'); delete accounts[app]; await load();
        document.getElementById('connector-notice').textContent = '';
      }, disconnect);
    });
    document.getElementById('connector-modal-close').addEventListener('click', close);
    modal().addEventListener('click', event => { if (event.target === modal()) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && activeApp) close(); });
    modal().addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...modal().querySelectorAll('button:not(:disabled), input, summary, a')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.getElementById('connector-auth-form').addEventListener('submit', event => {
      event.preventDefault(); const form = event.target, app = activeApp, button = form.querySelector('[type="submit"]');
      void safely(async () => {
        const values = Object.fromEntries([...new FormData(form)].filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, value.trim()]));
        try {
          if (Object.keys(values).length) await request('/' + app + '/credentials', 'PUT', values);
          if (app !== 'gmail' && !values.token) throw new Error(text('empty'));
        } finally { form.reset(); }
        delete accounts[app];
        if (app === 'gmail') {
          const result = await request('/gmail/oauth/start', 'POST'), target = new URL(result.url);
          if (target.origin !== 'https://accounts.google.com') throw new Error(text('failed'));
          if (/Electron/i.test(navigator.userAgent)) {
            externalAuthorization = true; close(); window.open(target.toString(), '_blank', 'noopener,noreferrer'); notice(text('authOpened'));
          } else location.assign(target.toString());
        } else {
          await verify(app); close(); await load(); notice(text('done'));
        }
      }, button);
    });
    window.addEventListener('focus', () => { if (externalAuthorization) void load(); });
    const auth = new URLSearchParams(location.search).get('gmail');
    if (auth) {
      history.replaceState(null, '', '/?page=connectors');
      if (auth === 'connected') void safely(async () => { await verify('gmail'); await load(); notice(text('done')); });
      else notice(text('authFailed'), true);
    }
    render();
  }
  window.XiaoBaConnectors = { init, load, render };
})();
