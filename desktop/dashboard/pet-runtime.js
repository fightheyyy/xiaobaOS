(function () {
  'use strict';

  // GrokBot eye geometry and state cadences: nasawz/GrokBot (BSD-3-Clause).
  // Spring morph and spherical projection follow dsh-thought-buddy's BSD-3 web port.
  // See LICENSE-GROKBOT beside this file.
  const cell = { width: 192, height: 208 };
  const animations = {
    idle: { durations: [280, 110, 110, 140, 140, 320], label: 'idle', expressionState: 'idle' },
    'running-right': { durations: [120, 120, 120, 120, 120, 120, 120, 220], label: 'running-right', expressionState: 'dragging' },
    'running-left': { durations: [120, 120, 120, 120, 120, 120, 120, 220], label: 'running-left', expressionState: 'dragging' },
    waving: { durations: [140, 140, 140, 280], label: 'waving', expressionState: 'happy' },
    jumping: { durations: [140, 140, 140, 140, 280], label: 'jumping', expressionState: 'excited' },
    failed: { durations: [140, 140, 140, 140, 140, 140, 140, 240], label: 'failed', expressionState: 'sad' },
    waiting: { durations: [150, 150, 150, 150, 150, 260], label: 'waiting', expressionState: 'listening' },
    running: { durations: [120, 120, 120, 120, 120, 220], label: 'running', expressionState: 'working' },
    review: { durations: [150, 150, 150, 150, 150, 280], label: 'review', expressionState: 'thinking' },
  };

  const rendererName = 'grok-cat-v1';
  const designViewBox = { x: -18, y: -24, width: 294, height: 294 };
  const defaultRoleThemes = Object.freeze({
    base: { body: '#17140F', eyes: '#E5B94F', outline: '#C79A3B' },
    'user-cat': { body: '#E76F51', eyes: '#281A12' },
    'inspector-cat': { body: '#3A86FF', eyes: '#FFFDF7' },
    'reviewer-cat': { body: '#8338EC', eyes: '#FFFDF7' },
    'engineer-cat': { body: '#2A9D78', eyes: '#FFFDF7' },
    'browser-cat': { body: '#19A7CE', eyes: '#14272D' },
    'gui-cat': { body: '#E85D9E', eyes: '#2B1721' },
    'secretary-cat': { body: '#F4A261', eyes: '#2B1C12' },
    'evolution-cat': { body: '#74A94A', eyes: '#17220F' },
  });
  const customRolePaletteCapacity = 4096;
  let customRolePalette = null;

  function normalizeRoleKey(roleKey) {
    const normalized = String(roleKey || 'base')
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'base';
  }

  function normalizeHexColor(value) {
    const match = String(value || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return null;
    const hex = match[1].length === 3
      ? Array.from(match[1]).map(character => character + character).join('')
      : match[1];
    return '#' + hex.toUpperCase();
  }

  function relativeLuminance(hex) {
    const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4));
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  function contrastRatio(first, second) {
    const lighter = Math.max(first, second);
    const darker = Math.min(first, second);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function automaticEyeColor(bodyColor) {
    const body = relativeLuminance(bodyColor);
    const dark = '#211812';
    const light = '#FFFDF7';
    return contrastRatio(body, relativeLuminance(dark)) >= contrastRatio(body, relativeLuminance(light))
      ? dark
      : light;
  }

  function hslToHex(hue, saturation, lightness) {
    const normalizedHue = ((hue % 360) + 360) % 360;
    const saturationRatio = clamp(saturation / 100, 0, 1);
    const lightnessRatio = clamp(lightness / 100, 0, 1);
    const chroma = (1 - Math.abs(2 * lightnessRatio - 1)) * saturationRatio;
    const segment = normalizedHue / 60;
    const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
    const channels = segment < 1 ? [chroma, secondary, 0]
      : segment < 2 ? [secondary, chroma, 0]
        : segment < 3 ? [0, chroma, secondary]
          : segment < 4 ? [0, secondary, chroma]
            : segment < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
    const match = lightnessRatio - chroma / 2;
    return '#' + channels
      .map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  function getCustomRolePalette() {
    if (customRolePalette) return customRolePalette;
    const palette = [];
    const used = new Set(Object.values(defaultRoleThemes).map(theme => theme.body));
    const saturations = [72, 84, 62, 76, 90, 56, 68, 80];
    const lightnesses = [48, 58, 40, 66, 52, 44, 62, 36];
    const maximumAttempts = customRolePaletteCapacity * 16;

    for (let ordinal = 0; ordinal < maximumAttempts && palette.length < customRolePaletteCapacity; ordinal += 1) {
      const band = Math.floor(ordinal / 360);
      const hue = (24 + ordinal * 137.50776405003785) % 360;
      const saturation = saturations[band % saturations.length];
      const lightness = lightnesses[Math.floor(band / saturations.length) % lightnesses.length];
      const body = hslToHex(hue, saturation, lightness);
      if (used.has(body)) continue;
      used.add(body);
      palette.push(body);
    }

    if (palette.length !== customRolePaletteCapacity) {
      throw new Error('unable to construct the custom role color palette');
    }
    customRolePalette = Object.freeze(palette);
    return customRolePalette;
  }

  function stableRoleHash(role) {
    let hash = 2166136261;
    for (let index = 0; index < role.length; index += 1) {
      hash ^= role.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normalizeManifestThemes(manifestThemes) {
    const normalized = {};
    if (!manifestThemes || typeof manifestThemes !== 'object') return normalized;
    Object.entries(manifestThemes).forEach(([roleKey, theme]) => {
      if (!theme || typeof theme !== 'object') return;
      const role = normalizeRoleKey(roleKey);
      if (!Object.prototype.hasOwnProperty.call(normalized, role)) normalized[role] = theme;
    });
    return normalized;
  }

  function normalizeTheme(role, supplied, fallback) {
    const body = normalizeHexColor(supplied && supplied.body)
      || normalizeHexColor(fallback && fallback.body);
    if (!body) throw new Error('missing body color for role: ' + role);
    const eyes = normalizeHexColor(supplied && supplied.eyes)
      || normalizeHexColor(fallback && fallback.eyes)
      || automaticEyeColor(body);
    const suppliedOutline = supplied && Object.prototype.hasOwnProperty.call(supplied, 'outline')
      ? supplied.outline
      : fallback && fallback.outline;
    return {
      role,
      body,
      eyes,
      outline: normalizeHexColor(suppliedOutline),
    };
  }

  function allocateUniqueRoleBody(role, usedBodies) {
    const palette = getCustomRolePalette();
    const start = stableRoleHash(role) % palette.length;
    for (let offset = 0; offset < palette.length; offset += 1) {
      const candidate = palette[(start + offset) % palette.length];
      if (!usedBodies.has(candidate)) return candidate;
    }
    throw new Error('custom role color palette exhausted');
  }

  function buildUniqueRoleThemes(roleKeys, manifestThemes) {
    const roles = new Set(Object.keys(defaultRoleThemes));
    const roleOrigins = new Map(Object.keys(defaultRoleThemes).map(role => [role, role]));
    if (Array.isArray(roleKeys)) {
      roleKeys.forEach(roleKey => {
        const source = String(roleKey || 'base').trim() || 'base';
        const role = normalizeRoleKey(source);
        const existing = roleOrigins.get(role);
        if (existing && existing !== source) {
          throw new Error('role keys collide after normalization: ' + existing + ', ' + source);
        }
        roleOrigins.set(role, source);
        roles.add(role);
      });
    }

    const suppliedThemes = normalizeManifestThemes(manifestThemes);
    const result = {};
    const usedBodies = new Set();
    const defaultRoles = Object.keys(defaultRoleThemes);
    const customRoles = Array.from(roles)
      .filter(role => !Object.prototype.hasOwnProperty.call(defaultRoleThemes, role))
      .sort();

    defaultRoles.concat(customRoles).forEach(role => {
      const supplied = suppliedThemes[role] || null;
      let fallback = defaultRoleThemes[role] || null;
      if (!fallback) {
        fallback = normalizeHexColor(supplied && supplied.body)
          ? { body: supplied.body }
          : { body: allocateUniqueRoleBody(role, usedBodies) };
      }
      let theme = normalizeTheme(role, supplied, fallback);

      if (usedBodies.has(theme.body)) {
        const body = allocateUniqueRoleBody(role, usedBodies);
        theme = normalizeTheme(role, supplied && {
          ...supplied,
          body,
        }, { body });
      }

      usedBodies.add(theme.body);
      result[role] = {
        body: theme.body,
        eyes: theme.eyes,
        outline: theme.outline,
      };
    });

    return result;
  }

  function getRoleTheme(roleKey, manifestThemes) {
    const role = normalizeRoleKey(roleKey);
    const supplied = normalizeManifestThemes(manifestThemes)[role] || null;
    const fallback = defaultRoleThemes[role] || {
      body: getCustomRolePalette()[stableRoleHash(role) % customRolePaletteCapacity],
    };
    return normalizeTheme(role, supplied, fallback);
  }

  function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function centroid(ring) {
    let x = 0;
    let y = 0;
    for (const point of ring) {
      x += point[0];
      y += point[1];
    }
    return { x: x / ring.length, y: y / ring.length };
  }

  function lerpExpressions(current, target, amount) {
    return current.map((ring, eyeIndex) => ring.map((point, pointIndex) => {
      const next = target[eyeIndex][pointIndex];
      return [
        point[0] + (next[0] - point[0]) * amount,
        point[1] + (next[1] - point[1]) * amount,
      ];
    }));
  }

  function getProceduralData() {
    const data = window.XiaoBaGrokBotData;
    if (!data || !Array.isArray(data.expressions) || data.expressions.length !== 25) {
      throw new Error('GrokBot animation data is missing or invalid');
    }
    return data;
  }

  function traceCatBody(ctx) {
    ctx.beginPath();
    ctx.moveTo(114.27, 9.27);
    ctx.bezierCurveTo(96, 9.27, 79, 14, 65, 23);
    ctx.lineTo(48, -14);
    ctx.bezierCurveTo(46, -18, 42, -17, 40, -12);
    ctx.lineTo(26, 46);
    ctx.bezierCurveTo(15, 64, 9.27, 87, 9.27, 114.27);
    ctx.bezierCurveTo(9.27, 172.26, 56.28, 219.27, 114.27, 219.27);
    ctx.bezierCurveTo(172.26, 219.27, 219.27, 172.26, 219.27, 114.27);
    ctx.bezierCurveTo(219.27, 87, 213.5, 64, 202, 46);
    ctx.lineTo(188, -12);
    ctx.bezierCurveTo(186, -17, 182, -18, 180, -14);
    ctx.lineTo(163, 23);
    ctx.bezierCurveTo(149, 14, 132, 9.27, 114.27, 9.27);
    ctx.closePath();
  }

  function traceTailTip(ctx) {
    ctx.beginPath();
    ctx.moveTo(244, 83);
    ctx.lineTo(260, 89);
    ctx.lineTo(254, 104);
    ctx.lineTo(251, 94);
    ctx.closePath();
  }

  function drawTail(ctx, theme, angle) {
    ctx.save();
    ctx.translate(196, 165);
    ctx.rotate(angle * Math.PI / 180);
    ctx.translate(-196, -165);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const traceLine = () => {
      ctx.beginPath();
      ctx.moveTo(198, 166);
      ctx.bezierCurveTo(236, 181, 253, 150, 243, 124);
      ctx.bezierCurveTo(238, 111, 242, 99, 253, 92);
    };

    if (theme.outline) {
      traceLine();
      ctx.strokeStyle = theme.outline;
      ctx.lineWidth = 18;
      ctx.stroke();
    }
    traceLine();
    ctx.strokeStyle = theme.body;
    ctx.lineWidth = 14;
    ctx.stroke();

    traceTailTip(ctx);
    ctx.fillStyle = theme.body;
    ctx.fill();
    if (theme.outline) {
      ctx.strokeStyle = theme.outline;
      ctx.lineWidth = 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  function motionForState(state, elapsed, reducedMotion) {
    if (reducedMotion) {
      return { bob: 0, tilt: 0, scaleX: 1, scaleY: 1, turnBias: 0, tailAngle: 0 };
    }

    let bob = Math.sin(elapsed * 2.25) * 1.5;
    let tilt = 0;
    let scaleX = 1;
    let scaleY = 1;
    let turnBias = 0;
    let tailBase = 0;
    let tailAmplitude = 5.5;
    let tailFrequency = 1.75;

    if (state === 'running-right' || state === 'running-left') {
      const direction = state === 'running-right' ? 1 : -1;
      bob = -Math.abs(Math.sin(elapsed * 7)) * 2.5;
      tilt = direction * 0.025;
      turnBias = direction * 0.16;
      tailBase = -direction * 4;
      tailAmplitude = 9;
      tailFrequency = 4.8;
    } else if (state === 'waving') {
      bob = -Math.abs(Math.sin(elapsed * 4.2)) * 3.2;
      tilt = Math.sin(elapsed * 3) * 0.018;
      tailAmplitude = 13;
      tailFrequency = 4.4;
    } else if (state === 'jumping') {
      const lift = Math.abs(Math.sin(elapsed * 3.8));
      bob = -lift * 9;
      scaleX = 1 - lift * 0.025;
      scaleY = 1 + lift * 0.035;
      tailAmplitude = 10;
      tailFrequency = 3.8;
    } else if (state === 'failed') {
      bob = 2 + Math.sin(elapsed * 1.3) * 0.6;
      scaleX = 1.018;
      scaleY = 0.965;
      tailBase = 18;
      tailAmplitude = 2;
      tailFrequency = 1.2;
    } else if (state === 'waiting') {
      bob = Math.sin(elapsed * 1.8) * 1.1;
      turnBias = Math.sin(elapsed * 0.7) * 0.035;
    } else if (state === 'running') {
      bob = -Math.abs(Math.sin(elapsed * 5.4)) * 2.3;
      tailAmplitude = 8;
      tailFrequency = 3.5;
    } else if (state === 'review') {
      bob = Math.sin(elapsed * 1.65) * 1.1;
      tilt = Math.sin(elapsed * 0.8) * 0.012;
      turnBias = Math.sin(elapsed * 0.62) * 0.045;
    }

    return {
      bob,
      tilt,
      scaleX,
      scaleY,
      turnBias,
      tailAngle: tailBase + Math.sin(elapsed * tailFrequency) * tailAmplitude,
    };
  }

  function createPetEventId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  class PetPlayer {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.state = 'idle';
      this.rafId = 0;
      this.onState = options.onState || (() => {});
      this.role = 'base';
      this.roleThemes = null;
      this.theme = getRoleTheme('base');
      this.data = null;
      this.expressionState = null;
      this.currentIndex = 0;
      this.currentExpression = null;
      this.targetExpression = null;
      this.morph = 1;
      this.morphVelocity = 0;
      this.blinkTime = -1;
      this.expressionAt = Infinity;
      this.blinkAt = Infinity;
      this.firstTimestamp = 0;
      this.lastTimestamp = 0;
      this.reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    load(source, options = {}) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.ctx.clearRect(0, 0, cell.width, cell.height);
      const manifest = source && typeof source === 'object' ? source : null;
      const renderer = manifest && manifest.renderer;
      if (renderer !== rendererName) {
        throw new Error('unsupported pet renderer: ' + (renderer || 'missing'));
      }
      this.roleThemes = manifest && manifest.roleThemes && typeof manifest.roleThemes === 'object'
        ? manifest.roleThemes
        : null;
      this.setRole(options.role || this.role || 'base');
      this.data = getProceduralData();
      this.setState('idle', true);
      if (options.autoplay !== false) {
        this.start();
      }
    }

    start() {
      cancelAnimationFrame(this.rafId);
      this.firstTimestamp = 0;
      this.lastTimestamp = 0;
      this.rafId = requestAnimationFrame(now => this.tick(now));
    }

    setRole(roleKey) {
      this.role = normalizeRoleKey(roleKey);
      this.theme = getRoleTheme(this.role, this.roleThemes);
      this.drawProcedural(performance.now());
      return { ...this.theme };
    }

    setColors(body, eyes, outline) {
      const bodyColor = normalizeHexColor(body);
      if (!bodyColor) return false;
      const eyeColor = normalizeHexColor(eyes) || automaticEyeColor(bodyColor);
      this.theme = {
        role: this.role,
        body: bodyColor,
        eyes: eyeColor,
        outline: normalizeHexColor(outline),
      };
      this.drawProcedural(performance.now());
      return true;
    }

    getTheme() {
      return { ...this.theme };
    }

    setState(state, force = false) {
      if (!animations[state]) state = 'idle';
      if (this.state !== state || force) {
        this.state = state;
        this.resetProceduralState();
        this.draw();
      }
      this.onState(state, animations[state]);
    }

    getState() {
      return this.state;
    }

    draw() {
      this.drawProcedural(performance.now());
    }

    tick(now) {
      this.tickProcedural(now);
      this.rafId = requestAnimationFrame(next => this.tick(next));
    }

    resetProceduralState() {
      if (!this.data) return;
      const animation = animations[this.state] || animations.idle;
      const nextState = this.data.expressionStates[animation.expressionState]
        || this.data.expressionStates.idle;
      this.expressionState = nextState;
      this.currentIndex = nextState.expressions[0];
      this.currentExpression = this.data.expressions[this.currentIndex];
      this.targetExpression = this.currentExpression;
      this.morph = 1;
      this.morphVelocity = 0;
      this.blinkTime = -1;
      const now = performance.now();
      this.expressionAt = now + randomInt(nextState.expressionMin, nextState.expressionMax);
      this.blinkAt = nextState.blinkMin == null
        ? Infinity
        : now + randomInt(nextState.blinkMin, nextState.blinkMax);
    }

    startExpressionTransition() {
      if (!this.expressionState || !this.currentExpression || !this.targetExpression) return;
      const alternatives = this.expressionState.expressions.filter(index => index !== this.currentIndex);
      const nextIndex = alternatives.length
        ? alternatives[Math.floor(Math.random() * alternatives.length)]
        : this.expressionState.expressions[0];
      this.currentExpression = lerpExpressions(
        this.currentExpression,
        this.targetExpression,
        clamp(this.morph, 0, 1),
      );
      this.targetExpression = this.data.expressions[nextIndex];
      this.currentIndex = nextIndex;
      this.morph = 0;
      this.morphVelocity = 0;
    }

    blinkScale() {
      if (this.blinkTime < 0) return 1;
      const progress = this.blinkTime / 0.32;
      return Math.max(
        progress < 0.42
          ? 1 - progress / 0.42
          : (progress - 0.42) / 0.58,
        0.04,
      );
    }

    tickProcedural(timestamp) {
      if (!this.data || !this.expressionState) return;
      if (!this.firstTimestamp) {
        this.firstTimestamp = timestamp;
        this.lastTimestamp = timestamp;
      }
      const delta = clamp((timestamp - this.lastTimestamp) / 1000, 0, 0.1);
      this.lastTimestamp = timestamp;
      const now = performance.now();

      if (Math.abs(this.morph - 1) >= 0.001 || Math.abs(this.morphVelocity) >= 0.001) {
        let remaining = delta;
        while (remaining > 0) {
          const step = Math.min(remaining, 1 / 120);
          this.morphVelocity += (-14 * this.morphVelocity - 49 * (this.morph - 1)) * step;
          this.morph += this.morphVelocity * step;
          remaining -= step;
        }
        if (Math.abs(this.morph - 1) < 0.001 && Math.abs(this.morphVelocity) < 0.001) {
          this.morph = 1;
          this.morphVelocity = 0;
          this.currentExpression = this.targetExpression;
        }
      }

      if (this.expressionState.expressions.length > 1 && now >= this.expressionAt) {
        this.startExpressionTransition();
        this.expressionAt = now + randomInt(
          this.expressionState.expressionMin,
          this.expressionState.expressionMax,
        );
      }

      if (this.blinkTime >= 0) {
        this.blinkTime += delta;
        if (this.blinkTime >= 0.32) {
          this.blinkTime = -1;
          this.blinkAt = this.expressionState.blinkMin == null
            ? Infinity
            : now + randomInt(this.expressionState.blinkMin, this.expressionState.blinkMax);
        }
      } else if (now >= this.blinkAt && this.expressionState.blinkMin != null) {
        this.blinkTime = 0;
      }

      this.drawProcedural(timestamp);
    }

    drawProcedural(timestamp) {
      if (!this.data || !this.currentExpression || !this.targetExpression) return;
      const elapsed = this.firstTimestamp ? (timestamp - this.firstTimestamp) / 1000 : 0;
      const motion = motionForState(this.state, elapsed, this.reducedMotion);
      const rings = lerpExpressions(
        this.currentExpression,
        this.targetExpression,
        clamp(this.morph, 0, 1),
      );
      const ctx = this.ctx;
      const scale = Math.min(
        (cell.width - 4) / designViewBox.width,
        (cell.height - 4) / designViewBox.height,
      );
      const offsetX = (cell.width - designViewBox.width * scale) / 2 - designViewBox.x * scale;
      const offsetY = (cell.height - designViewBox.height * scale) / 2 - designViewBox.y * scale;
      const faceCenter = this.data.viewBox.faceCenter;
      const inset = this.data.viewBox.inset;

      ctx.clearRect(0, 0, cell.width, cell.height);
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.translate(inset, inset + motion.bob);
      ctx.translate(faceCenter, faceCenter);
      ctx.rotate(motion.tilt);
      ctx.scale(motion.scaleX, motion.scaleY);
      ctx.translate(-faceCenter, -faceCenter);

      drawTail(ctx, this.theme, motion.tailAngle);
      traceCatBody(ctx);
      ctx.fillStyle = this.theme.body;
      ctx.fill();
      if (this.theme.outline) {
        ctx.strokeStyle = this.theme.outline;
        ctx.lineWidth = 2.4;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      ctx.save();
      traceCatBody(ctx);
      ctx.clip();
      this.drawEyes(ctx, rings, motion, elapsed);
      ctx.restore();
      ctx.restore();
    }

    drawEyes(ctx, rings, motion, elapsed) {
      const shape = this.data.shapes.blob;
      const faceCenter = this.data.viewBox.faceCenter;
      const origin = {
        x: faceCenter + shape.faceX,
        y: faceCenter + shape.faceY,
      };
      const radius = 105 * Math.min(shape.faceScaleX, shape.faceScaleY);
      const turn = motion.turnBias + (this.reducedMotion ? 0 : 0.1 * Math.sin(elapsed * 0.9));
      const gazeX = this.reducedMotion ? 0 : 0.45 * Math.sin(elapsed * 0.53);
      const gazeY = this.reducedMotion ? 0 : 0.3 * Math.cos(elapsed * 0.41);
      ctx.fillStyle = this.theme.eyes;

      for (let eyeIndex = 0; eyeIndex < 2; eyeIndex += 1) {
        const corrected = rings[eyeIndex].map(point => [
          origin.x + (point[0] - faceCenter) * shape.faceScaleX,
          origin.y + (point[1] - faceCenter) * shape.faceScaleY,
        ]);
        const center = centroid(corrected);
        const offset = center.x - origin.x;
        const baseLongitude = Math.asin(clamp(offset / Math.max(radius, 1), -1, 1));
        const longitude = baseLongitude + turn;
        const depth = Math.cos(longitude);
        if (depth <= 0.02) continue;

        const perspective = Math.max(depth, 0.02) / Math.max(Math.cos(baseLongitude), 0.02);
        const scaleX = clamp(perspective * shape.eyeScale, 0.02, 2.4);
        const scaleY = clamp(this.blinkScale() * shape.eyeScale, 0.02, 2.4);
        const projectedX = origin.x + radius * Math.sin(longitude) + gazeX;
        const projectedY = center.y + gazeY;

        ctx.beginPath();
        corrected.forEach((point, pointIndex) => {
          const x = projectedX + (point[0] - center.x) * scaleX;
          const y = projectedY + (point[1] - center.y) * scaleY;
          if (pointIndex === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
      }
    }

    destroy() {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
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
    rendererName,
    defaultRoleThemes,
    customRolePaletteCapacity,
    normalizeRoleKey,
    buildUniqueRoleThemes,
    getRoleTheme,
    PetPlayer,
    PetClient,
    createEventHandler,
  };
})();
