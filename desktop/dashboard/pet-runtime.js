(function () {
  const cell = { width: 192, height: 208 };
  const animations = {
    idle: { row: 0, durations: [280, 110, 110, 140, 140, 320], label: 'idle' },
    'running-right': { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220], label: 'running-right' },
    'running-left': { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220], label: 'running-left' },
    waving: { row: 3, durations: [140, 140, 140, 280], label: 'waving' },
    jumping: { row: 4, durations: [140, 140, 140, 140, 280], label: 'jumping' },
    failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240], label: 'failed' },
    waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260], label: 'waiting' },
    running: { row: 7, durations: [120, 120, 120, 120, 120, 220], label: 'running' },
    review: { row: 8, durations: [150, 150, 150, 150, 150, 280], label: 'review' },
  };

  function createPetEventId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  class SpritePlayer {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.atlas = new Image();
      this.state = 'idle';
      this.frame = 0;
      this.frameStartedAt = 0;
      this.rafId = 0;
      this.onState = options.onState || (() => {});
    }

    load(src) {
      this.ctx.clearRect(0, 0, cell.width, cell.height);
      this.atlas.onload = () => {
        cancelAnimationFrame(this.rafId);
        this.setState('idle', true);
        this.rafId = requestAnimationFrame(now => this.tick(now));
      };
      this.atlas.src = src;
    }

    setState(state, force = false) {
      if (!animations[state]) state = 'idle';
      if (this.state !== state || force) {
        this.state = state;
        this.frame = 0;
        this.frameStartedAt = performance.now();
        this.draw();
      }
      this.onState(state, animations[state]);
    }

    getState() {
      return this.state;
    }

    draw() {
      if (!this.atlas.complete || !this.atlas.naturalWidth) return;
      const cfg = animations[this.state] || animations.idle;
      this.ctx.clearRect(0, 0, cell.width, cell.height);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(
        this.atlas,
        this.frame * cell.width,
        cfg.row * cell.height,
        cell.width,
        cell.height,
        0,
        0,
        cell.width,
        cell.height
      );
    }

    tick(now) {
      const cfg = animations[this.state] || animations.idle;
      const duration = cfg.durations[this.frame] || 140;
      if (!this.frameStartedAt) this.frameStartedAt = now;
      if (now - this.frameStartedAt >= duration) {
        this.frame = (this.frame + 1) % cfg.durations.length;
        this.frameStartedAt = now;
        this.draw();
      }
      this.rafId = requestAnimationFrame(next => this.tick(next));
    }

    destroy() {
      cancelAnimationFrame(this.rafId);
    }
  }

  class PetClient {
    constructor(options = {}) {
      this.api = options.api || '';
    }

    async getPets() {
      const response = await fetch(this.api + '/api/pet/pets');
      if (!response.ok) throw new Error('无法加载 pet');
      return response.json();
    }

    async wake(petId, options = {}) {
      const response = await fetch(this.api + '/api/pet/wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ petId, sessionKey: options.sessionKey }),
      });
      if (!response.ok) throw new Error('唤醒失败');
      return response.json();
    }

    async sendMessage(petId, text, onEvent, options = {}) {
      const response = await fetch(this.api + '/api/pet/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          petId,
          text,
          source: options.source || 'unknown',
          sessionKey: options.sessionKey,
          eventId: options.eventId || createPetEventId(),
        }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '请求失败');
      }
      if (onEvent) {
        await readEventStream(response.body, onEvent);
      } else {
        await drainStream(response.body);
      }
    }

    connect(petId, onEvent, options = {}) {
      if (!petId || !window.EventSource) return null;
      const replay = options.replay ? '&replay=1' : '';
      const session = options.sessionKey ? '&sessionKey=' + encodeURIComponent(options.sessionKey) : '';
      const source = new EventSource(this.api + '/api/pet/events?petId=' + encodeURIComponent(petId) + session + replay);
      source.onmessage = event => onEvent(JSON.parse(event.data));
      source.onerror = () => {
        source.close();
        if (options.reconnect !== false) {
          setTimeout(() => this.connect(petId, onEvent, options), options.retryMs || 1200);
        }
      };
      return source;
    }
  }

  async function readEventStream(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find(item => item.startsWith('data: '));
        if (line) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }

  async function drainStream(body) {
    const reader = body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  function createEventHandler(options) {
    let textBuffer = '';
    let textMode = 'message';
    let turnHasText = false;
    return event => {
      if (event.type === 'connected') return;
      if (event.type === 'user_message') {
        textBuffer = '';
        textMode = 'message';
        turnHasText = false;
        options.onUserMessage?.(event);
        return;
      }
      if (event.type === 'state') {
        options.setState(event.state);
        textMode = event.reason === 'text_stream' ? 'stream' : 'message';
        if (event.reason === 'processing' || event.state === 'jumping') textBuffer = '';
        options.onState?.(event);
        return;
      }
      if (event.type === 'text') {
        const chunk = event.text || '';
        const text = textMode === 'stream' ? (textBuffer += chunk) : chunk;
        turnHasText = turnHasText || Boolean(text);
        options.setState('review');
        options.onText?.(event, text, { mode: textMode });
        return;
      }
      if (event.type === 'thinking') {
        options.setState('review');
        options.onThinking?.(event);
        return;
      }
      if (event.type === 'tool_start') {
        textBuffer = '';
        textMode = 'message';
        options.setState('running');
        options.onToolStart?.(event);
        return;
      }
      if (event.type === 'tool_end') {
        options.setState('waiting');
        options.onToolEnd?.(event);
        return;
      }
      if (event.type === 'tool_display') {
        options.onToolDisplay?.(event);
        return;
      }
      if (event.type === 'retry') {
        options.setState('waiting');
        options.onRetry?.(event);
        return;
      }
      if (event.type === 'file') {
        options.setState('waving');
        options.onFile?.(event);
        return;
      }
      if (event.type === 'error') {
        options.setState('failed');
        options.onError?.(event);
        return;
      }
      if (event.type === 'done') {
        const alreadyRenderedText = turnHasText;
        textBuffer = '';
        textMode = 'message';
        turnHasText = false;
        options.setState('waving');
        options.onDone?.(event, { alreadyRenderedText });
      }
    };
  }

  window.XiaoBaPetRuntime = {
    animations,
    SpritePlayer,
    PetClient,
    createEventHandler,
  };
})();
