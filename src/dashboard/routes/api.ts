import { Router } from 'express';
import { SkillManager } from '../../skills/skill-manager';
import { ConfigManager } from '../../utils/config';
import { ServiceManager } from '../service-manager';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as https from 'https';
import * as http from 'http';
import { getDashboardActiveRole, registerDashboardApiExtensions } from '../../bootstrap/dashboard-api';
import { createPetRouter } from '../../pet/channel';
import { PathResolver } from '../../utils/path-resolver';
import { RoleResolver } from '../../utils/role-resolver';
import { RoleManager } from '../../roles/role-manager';
import { SkillParser } from '../../skills/skill-parser';
import type { Skill } from '../../types/skill';
import matter from 'gray-matter';
import { execSync } from 'child_process';
import { APP_VERSION } from '../../version';
import { getObservability } from '../../observability';
import { getDashboardObservabilityReviewState } from '../observability-actions';
// import { ReportGenerator } from '../../utils/report-generator';
// import { LogUploader } from '../../utils/log-uploader';

const DASHBOARD_PAGES = new Set(['services', 'pet', 'config', 'skills', 'roles', 'store']);
const DASHBOARD_HIDDEN_SKILLS = new Set(['sub-agent', 'background-task-runner']);
let dashboardNavigationRequest: { id: number; page: string; createdAt: number } | null = null;
let dashboardNavigationRequestId = 0;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSensitiveConfigKey(key: string): boolean {
  return /(^|_)(API_KEY|APP_SECRET|SECRET|PASSWORD|TOKEN)$/i.test(key);
}

function isMaskedConfigValue(value: string): boolean {
  return value.startsWith('****');
}

function applyRuntimeEnvUpdates(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== 'string' || isMaskedConfigValue(value)) continue;
    process.env[key] = value;
  }
}

function normalizeDashboardPage(value: unknown): string | null {
  const page = typeof value === 'string' ? value.trim() : '';
  return DASHBOARD_PAGES.has(page) ? page : null;
}

const SAFE_OBSERVABILITY_ATTRIBUTE_KEYS = new Set([
  'xiaoba.blocked_reason',
  'xiaoba.delivery.status',
  'xiaoba.error_code',
  'xiaoba.job.kind',
  'xiaoba.job.operation',
  'xiaoba.model.name',
  'xiaoba.model.status',
  'xiaoba.provider.name',
  'xiaoba.role.name',
  'xiaoba.session.final_response_visible',
  'xiaoba.session.id_hash',
  'xiaoba.session.status',
  'xiaoba.session.visible_to_user',
  'xiaoba.skill.name',
  'xiaoba.subagent.role',
  'xiaoba.surface',
  'xiaoba.tool.name',
  'xiaoba.tool.status',
  'xiaoba.trace.cross_process',
  'xiaoba.trace.parent_propagated',
  'xiaoba.trace.parent_source',
]);

const REDACTED_SECRET = '<redacted-secret>';
const REDACTED_PATH = '<redacted-path>';

function redactObservabilityString(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, REDACTED_SECRET)
    .replace(/\bsecret-token-[A-Za-z0-9_-]+\b/gi, REDACTED_SECRET)
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;)\\\]}]+)/gi, `$1${REDACTED_SECRET}`)
    .replace(/\/(?:Users|home)\/[^\s"',;)\\\]}]+/g, REDACTED_PATH)
    .replace(/\/(?:private\/tmp|tmp|var\/folders)\/[^\s"',;)\\\]}]+/g, REDACTED_PATH)
    .replace(/[A-Za-z]:\\[^\s"',;)\\\]}]+/g, REDACTED_PATH);
}

function redactObservabilityAttributes(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SAFE_OBSERVABILITY_ATTRIBUTE_KEYS.has(key)) {
      redacted[key] = typeof child === 'string'
        ? redactObservabilityString(child)
        : child;
    }
  }
  return redacted;
}

function redactObservabilitySummary(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactObservabilityString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactObservabilitySummary);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attributes') {
      redacted[key] = redactObservabilityAttributes(child);
    } else {
      redacted[key] = redactObservabilitySummary(child);
    }
  }
  return redacted;
}

export interface DashboardApiOptions {
  onNavigate?: (page: string) => void;
  observabilityRootDir?: string;
  observabilityOutputRoot?: string;
}

/**
 * 安装 skill 的 npm 依赖（读取 SKILL.md 的 npm-dependencies 字段）
 */
function installSkillNpmDeps(skillDir: string): void {
  const skillMdPath = ['SKILL.md', 'SKILL.MD'].map(f => path.join(skillDir, f)).find(f => fs.existsSync(f));
  if (!skillMdPath) return;

  try {
    const { data } = matter(fs.readFileSync(skillMdPath, 'utf-8'));
    const deps: string[] = data['npm-dependencies'];
    if (!deps || !Array.isArray(deps) || deps.length === 0) return;

    const { execSync } = require('child_process');
    const projectRoot = process.cwd();
    execSync(`npm install --no-save ${deps.join(' ')}`, { cwd: projectRoot, timeout: 120000 });
  } catch (e: any) {
    // npm 安装失败不阻塞
  }
}

export function createApiRouter(serviceManager: ServiceManager, options: DashboardApiOptions = {}): Router {
  const router = Router();
  router.use(createPetRouter());

  // ==================== 总览 ====================

  router.get('/status', (_req, res) => {
    const config = ConfigManager.getConfig();
    const services = serviceManager.getAll();
    const activeRole = getDashboardActiveRole();
    res.json({
      version: APP_VERSION,
      role: activeRole,
      roleDetail: getRoleSummary(activeRole || 'base', activeRole),
      hostname: os.hostname(),
      platform: os.platform(),
      nodeVersion: process.version,
      cwd: process.cwd(),
      model: config.model,
      provider: config.provider,
      skillsPath: PathResolver.getSkillsPath(),
      services,
    });
  });

  router.get('/observability/summary', (_req, res) => {
    res.json(redactObservabilitySummary(getObservability().getLocalSummary()));
  });

  router.get('/observability/review', (_req, res) => {
    try {
      res.json(getDashboardObservabilityReviewState({
        rootDir: options.observabilityRootDir,
        outputRoot: options.observabilityOutputRoot,
      }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/navigation/pending', (req, res) => {
    const since = Number.parseInt(String(req.query.since || '0'), 10) || 0;
    if (!dashboardNavigationRequest || dashboardNavigationRequest.id <= since) {
      res.json({ id: dashboardNavigationRequestId, page: null });
      return;
    }
    res.json(dashboardNavigationRequest);
  });

  router.get('/navigation/open', (req, res) => {
    const page = normalizeDashboardPage(req.query.page);
    if (!page) {
      res.status(400).json({ error: 'Invalid dashboard page' });
      return;
    }
    dashboardNavigationRequest = {
      id: ++dashboardNavigationRequestId,
      page,
      createdAt: Date.now(),
    };
    let handled = false;
    try {
      if (options.onNavigate) {
        options.onNavigate(page);
        handled = true;
      }
    } catch {}
    res.json({ ok: true, handled, request: dashboardNavigationRequest });
  });

  // ==================== 角色管理 ====================

  router.get('/roles', async (_req, res) => {
    try {
      const activeRole = getDashboardActiveRole();
      const roles = [
        getBaseRoleSummary(activeRole),
        ...RoleManager.listRoles().map(role => getRoleSummary(role.name, activeRole)),
      ];
      res.json({
        active: activeRole || null,
        roles,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/roles/active', (req, res) => {
    try {
      const roleName = typeof req.body?.role === 'string' ? req.body.role.trim() : '';

      if (!roleName || ['base', 'default', 'none'].includes(RoleResolver.normalizeRoleName(roleName))) {
        RoleResolver.clearActiveRole();
      } else {
        RoleResolver.activateRole(roleName);
      }

      const activeRole = getDashboardActiveRole();
      const runningServices = serviceManager.getAll().filter(service => service.status === 'running');
      res.json({
        ok: true,
        active: activeRole || null,
        role: getRoleSummary(activeRole || 'base', activeRole),
        runningServices,
        requiresRestart: runningServices.length > 0,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/roles/:name', (req, res) => {
    try {
      const result = RoleManager.removeRole(req.params.name);
      const activeRole = getDashboardActiveRole();
      const runningServices = serviceManager.getAll().filter(service => service.status === 'running');
      res.json({
        ok: true,
        role: result,
        active: activeRole || null,
        runningServices,
        requiresRestart: runningServices.length > 0,
      });
    } catch (e: any) {
      const status = /not found/i.test(e.message) ? 404 : 400;
      res.status(status).json({ error: e.message });
    }
  });

  router.get('/roles/:name/skills', async (req, res) => {
    try {
      const roleName = req.params.name;
      const skills = await withTemporaryRole(roleName, async () => {
        const manager = new SkillManager();
        await manager.loadSkills();
        return manager.getAllSkills().map(s => ({
          name: s.metadata.name,
          aliases: s.metadata.aliases || [],
          description: s.metadata.description,
          argumentHint: s.metadata.argumentHint || null,
          userInvocable: s.metadata.userInvocable !== false,
          autoInvocable: s.metadata.autoInvocable !== false,
          maxTurns: s.metadata.maxTurns || null,
          path: s.filePath,
          roleOwned: s.filePath.includes(`${path.sep}roles${path.sep}`),
        }));
      });
      res.json(skills);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ==================== 服务管理 ====================

  router.get('/services', (_req, res) => {
    res.json(serviceManager.getAll());
  });

  router.post('/services/:name/start', (req, res) => {
    try {
      res.json(serviceManager.start(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/stop', (req, res) => {
    try {
      res.json(serviceManager.stop(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/services/:name/restart', (req, res) => {
    try {
      res.json(serviceManager.restart(req.params.name));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/services/:name/logs', (req, res) => {
    const lines = parseInt(req.query.lines as string) || 100;
    res.json(serviceManager.getLogs(req.params.name, lines));
  });

  // ==================== 配置管理 ====================

  router.get('/config', (_req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return res.json({});
      const content = fs.readFileSync(envPath, 'utf-8');
      const parsed = dotenv.parse(content);

      const masked = { ...parsed };
      for (const key of Object.keys(masked)) {
        if (masked[key] && masked[key].length > 4) {
          if (isSensitiveConfigKey(key)) {
            masked[key] = '****' + masked[key].slice(-4);
          }
        }
      }
      res.json(masked);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/config', (req, res) => {
    try {
      const envPath = path.join(process.cwd(), '.env');
      const updates: Record<string, string> = req.body;

      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
      const updatedKeys: string[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (typeof value !== 'string' || isMaskedConfigValue(value)) continue;
        const regex = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content += `\n${key}=${value}`;
        }
        updatedKeys.push(key);
      }

      fs.writeFileSync(envPath, content);
      applyRuntimeEnvUpdates(updates);
      res.json({ ok: true, updated: updatedKeys });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skills 管理 ====================

  router.get('/skills-all', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const summaries = new Map<string, DashboardSkillSummary>();
      const addSummary = (summary: DashboardSkillSummary) => {
        if (isDashboardHiddenSkill(summary)) return;
        summaries.set(normalizeSkillLookupName(summary.name), summary);
      };
      manager.getAllSkills().map(s => toDashboardSkillSummary(s)).forEach(addSummary);
      findEnabledBaseSkillsForDashboard().forEach(addSummary);
      res.json([...summaries.values()]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills', async (_req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      res.json(manager.getAllSkills().map(s => ({
        name: s.metadata.name,
        aliases: s.metadata.aliases || [],
        description: s.metadata.description,
        argumentHint: s.metadata.argumentHint || null,
        userInvocable: s.metadata.userInvocable !== false,
        autoInvocable: s.metadata.autoInvocable !== false,
        maxTurns: s.metadata.maxTurns || null,
        path: s.filePath,
        roleOwned: s.filePath.includes(`${path.sep}roles${path.sep}`),
        files: getSkillFiles(s.filePath),
      })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      res.json({
        name: skill.metadata.name,
        aliases: skill.metadata.aliases || [],
        description: skill.metadata.description,
        content: skill.content,
        path: skill.filePath,
        roleOwned: skill.filePath.includes(`${path.sep}roles${path.sep}`),
        files: getSkillFiles(skill.filePath),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/skills/:name', async (req, res) => {
    try {
      const manager = new SkillManager();
      await manager.loadSkills();
      const skill = manager.getSkill(req.params.name);
      if (!skill) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      fs.rmSync(path.dirname(skill.filePath), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== Skill Store ====================

  // GET /api/store - 可安装的skills（本地+远程registry合并）
  // ?refresh=1 强制刷新远程缓存
  router.get('/store', async (req, res) => {
    try {
      if (req.query.refresh === '1') {
        remoteRegistryCache = null;
        remoteRegistryCacheTime = 0;
      }
      const local = loadRegistry();
      const remote = await fetchRemoteRegistry();
      const registry = mergeRegistries(local, remote);
      const manager = new SkillManager();
      await manager.loadSkills();
      const installed = new Set(manager.getAllSkills().map(s => s.metadata.name));

      const available = registry
        .filter(entry => !isDashboardHiddenSkillName(entry.name))
        .map(entry => ({
          ...entry,
          installed: installed.has(entry.name),
        }));
      res.json(available);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install - 安装skill
  router.post('/store/install', async (req, res) => {
    try {
      const { name, repo, dir } = req.body;
      const skillsPath = PathResolver.getSkillsPath();
      const targetDir = path.join(skillsPath, dir || name);

      // 防止路径逃逸
      if (!targetDir.startsWith(skillsPath)) {
        return res.status(400).json({ error: '非法路径' });
      }

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `Skill "${name}" 已存在` });
      }

      if (repo === 'local') {
        return res.json({ ok: true, message: 'Skill already bundled' });
      }

      PathResolver.ensureDir(skillsPath);
      const warnings: string[] = [];

      // 优先用 ZIP 下载（不需要 git），失败时回退 git clone
      const installed = await installFromGitHub(repo, targetDir, warnings);
      if (!installed) {
        return res.status(500).json({ error: 'Skill 安装失败，请检查 URL 是否正确' });
      }

      const installedSkills = validateInstalledSkills(targetDir);

      // 安装依赖
      installPythonDeps(targetDir, warnings);
      installSkillNpmDeps(targetDir);

      res.json({
        ok: true,
        skills: installedSkills,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/store/install-github - 手动输入GitHub地址安装
  router.post('/store/install-github', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL is required' });

      // 从URL提取仓库名
      const repoName = url.replace(/\.git$/, '').split('/').pop();
      if (!repoName) return res.status(400).json({ error: 'Invalid URL' });

      const skillsPath = PathResolver.getSkillsPath();
      const targetDir = path.join(skillsPath, repoName);

      // 防止路径逃逸
      if (!targetDir.startsWith(skillsPath)) {
        return res.status(400).json({ error: '非法路径' });
      }

      if (fs.existsSync(targetDir)) {
        return res.status(400).json({ error: `目录 "${repoName}" 已存在` });
      }

      PathResolver.ensureDir(skillsPath);
      const warnings: string[] = [];

      const installed = await installFromGitHub(url, targetDir, warnings);
      if (!installed) {
        return res.status(500).json({ error: 'Skill 安装失败，请检查 URL 是否正确' });
      }

      const installedSkills = validateInstalledSkills(targetDir);

      // 安装依赖
      installPythonDeps(targetDir, warnings);
      installSkillNpmDeps(targetDir);

      res.json({
        ok: true,
        name: repoName,
        skills: installedSkills,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== 微信 Token 获取 ====================

  router.get('/weixin/qrcode', async (_req, res) => {
    try {
      const response = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/weixin/qrcode-status', async (req, res) => {
    try {
      const qrcode = req.query.qrcode as string;
      if (!qrcode) return res.status(400).json({ error: 'qrcode required' });
      const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${qrcode}`);
      const data = await response.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== 日志和报告 ====================
  // 注释：以下功能需要 report-generator 和 log-uploader 模块，暂时禁用

  /*
  router.post('/logs/upload', async (req, res) => {
    try {
      const { date } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const serverUrl = process.env.LOG_SERVER_URL;
      const apiKey = process.env.LOG_API_KEY;
      if (!serverUrl || !apiKey) {
        return res.status(500).json({ error: '未配置日志服务器' });
      }

      const uploader = new LogUploader(serverUrl, apiKey);
      await uploader.uploadLogs(path.resolve('logs/sessions'), date);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/reports/daily', (req, res) => {
    try {
      const date = req.query.date as string;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/reports/generate', (req, res) => {
    try {
      const { date, output } = req.body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const generator = new ReportGenerator();
      const report = generator.generateDailyReport(date);

      const outputPath = output || path.resolve(`logs/reports/${date}.json`);
      generator.saveReport(report, outputPath);

      res.json({ ok: true, path: outputPath, report });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  */

  registerDashboardApiExtensions(router);

  return router;
}

// ==================== Helpers ====================

const REMOTE_REGISTRY_URL = 'https://raw.githubusercontent.com/fightheyyy/XiaoBa-SkillHub/main/registry.json';
let remoteRegistryCache: any[] | null = null;
let remoteRegistryCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function loadRegistry(): any[] {
  const registryPath = path.join(process.cwd(), 'skill-registry.json');
  if (!fs.existsSync(registryPath)) return [];
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
}

function fetchRemoteRegistry(): Promise<any[]> {
  return new Promise((resolve) => {
    // Use cache if fresh
    if (remoteRegistryCache && (Date.now() - remoteRegistryCacheTime < CACHE_TTL)) {
      return resolve(remoteRegistryCache);
    }

    const doFetch = (url: string, redirects: number = 0) => {
      if (redirects > 5) return resolve([]);
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, { timeout: 8000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doFetch(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { return resolve([]); }
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            remoteRegistryCache = Array.isArray(parsed) ? parsed : [];
            remoteRegistryCacheTime = Date.now();
            resolve(remoteRegistryCache);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    };
    doFetch(REMOTE_REGISTRY_URL);
  });
}

function mergeRegistries(local: any[], remote: any[]): any[] {
  const map = new Map<string, any>();
  for (const entry of local) map.set(entry.name, entry);
  for (const entry of remote) {
    if (!map.has(entry.name)) map.set(entry.name, entry);
  }
  return Array.from(map.values());
}

/**
 * 从 GitHub 下载 ZIP 并解压到 targetDir，不依赖 git
 * 优先 ZIP 下载，失败则回退 git clone
 */
async function installFromGitHub(repoUrl: string, targetDir: string, warnings: string[]): Promise<boolean> {
  // 解析 GitHub URL → ZIP 下载地址
  // 支持格式: https://github.com/user/repo, https://github.com/user/repo.git
  const zipUrl = githubUrlToZip(repoUrl);

  if (zipUrl) {
    try {
      await downloadAndExtractZip(zipUrl, targetDir);
      return true;
    } catch (e: any) {
      warnings.push(`ZIP 下载失败 (${e.message})，尝试 git clone...`);
    }
  }

  // 回退：git clone
  try {
    execSync(`git clone ${repoUrl} "${targetDir}"`, { timeout: 60000 });
    return true;
  } catch (e: any) {
    warnings.push(`git clone 也失败: ${e.message}`);
    return false;
  }
}

/**
 * 将 GitHub 仓库 URL 转换为 ZIP 下载地址
 */
function githubUrlToZip(url: string): string | null {
  // https://github.com/user/repo(.git) → https://github.com/user/repo/archive/refs/heads/main.zip
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;
  const [, user, repo] = match;
  return `https://github.com/${user}/${repo}/archive/refs/heads/main.zip`;
}

/**
 * 下载 ZIP 并解压到目标目录
 * GitHub ZIP 格式: repo-main/ 下面才是文件，需要提升一层
 */
function downloadAndExtractZip(url: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpZip = path.join(os.tmpdir(), `xiaoba-skill-${Date.now()}.zip`);
    const file = fs.createWriteStream(tmpZip);

    const doRequest = (reqUrl: string, redirectCount: number = 0) => {
      if (redirectCount > 5) {
        fs.unlinkSync(tmpZip);
        return reject(new Error('Too many redirects'));
      }

      const protocol = reqUrl.startsWith('https') ? https : http;
      protocol.get(reqUrl, (response) => {
        // 跟随重定向
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return doRequest(response.headers.location, redirectCount + 1);
        }
        if (response.statusCode !== 200) {
          file.close();
          if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
          // 如果 main 分支不存在，尝试 master
          if (redirectCount === 0 && url.includes('/main.zip')) {
            const masterUrl = url.replace('/main.zip', '/master.zip');
            return doRequest(masterUrl, redirectCount + 1);
          }
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              extractZip(tmpZip, targetDir);
              resolve();
            } catch (e) {
              reject(e);
            } finally {
              if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
            }
          });
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
        reject(err);
      });
    };

    doRequest(url);
  });
}

/**
 * 使用内置工具解压 ZIP：优先 PowerShell（Windows 自带），回退 unzip
 */
function extractZip(zipPath: string, targetDir: string): void {
  const tmpExtract = path.join(os.tmpdir(), `xiaoba-extract-${Date.now()}`);
  fs.mkdirSync(tmpExtract, { recursive: true });

  try {
    if (process.platform === 'win32') {
      // PowerShell Expand-Archive（Windows 自带，无需额外安装）
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpExtract}' -Force"`,
        { timeout: 60000 }
      );
    } else {
      execSync(`unzip -o "${zipPath}" -d "${tmpExtract}"`, { timeout: 60000 });
    }

    // GitHub ZIP 里有一层 repo-branch/ 目录，提升到 targetDir
    const entries = fs.readdirSync(tmpExtract);
    const innerDir = entries.length === 1
      ? path.join(tmpExtract, entries[0])
      : tmpExtract;

    // 如果 innerDir 是单个目录，把里面的内容移出来
    if (fs.statSync(innerDir).isDirectory() && innerDir !== tmpExtract) {
      fs.renameSync(innerDir, targetDir);
    } else {
      fs.renameSync(tmpExtract, targetDir);
    }
  } finally {
    // 清理临时目录
    if (fs.existsSync(tmpExtract)) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
    }
  }
}

/**
 * 安装 Python 依赖：pip3 → pip → python -m pip 逐个尝试
 */
function installPythonDeps(skillDir: string, warnings: string[]): void {
  const reqFile = path.join(skillDir, 'requirements.txt');
  if (!fs.existsSync(reqFile)) return;

  const pipCommands = ['pip3', 'pip', 'python -m pip', 'python3 -m pip'];
  for (const cmd of pipCommands) {
    try {
      execSync(`${cmd} install -r "${reqFile}"`, { cwd: skillDir, timeout: 120000, stdio: 'pipe' });
      return; // 成功就返回
    } catch {
      // 继续尝试下一个
    }
  }
  warnings.push('Python 依赖安装失败：未找到 pip。请手动运行 pip install -r requirements.txt');
}

function getSkillFiles(skillFilePath: string): string[] {
  try {
    const dir = path.dirname(skillFilePath);
    return fs.readdirSync(dir).filter(e => !e.startsWith('.') && e !== '__pycache__');
  } catch { return []; }
}

function getBaseRoleSummary(activeRole?: string | null): any {
  return {
    name: 'base',
    displayName: 'Base',
    description: '默认 XiaoBa 角色，加载基础 prompt 和通用 skills。',
    aliases: ['default', 'none'],
    promptFile: 'system-prompt.md',
    active: !activeRole,
    path: null,
    roleSkillCount: 0,
    roleSkills: [],
    removable: false,
  };
}

function getRoleSummary(roleName: string, activeRole?: string | null): any {
  if (['base', 'default', 'none', ''].includes(RoleResolver.normalizeRoleName(roleName))) {
    return getBaseRoleSummary(activeRole);
  }

  const resolvedRoleName = RoleResolver.resolveRoleDirectoryName(roleName);
  if (!resolvedRoleName) {
    throw new Error(`Role not found: ${roleName}`);
  }
  const config = RoleResolver.getRoleConfig(resolvedRoleName);
  const rolePath = path.join(RoleResolver.getRolesRoot(), resolvedRoleName);
  const roleSkills = listRoleOwnedSkills(rolePath);

  return {
    name: resolvedRoleName,
    displayName: config?.displayName || resolvedRoleName,
    description: config?.description || '',
    aliases: config?.aliases || [],
    promptFile: config?.promptFile || null,
    inheritBaseSkills: config?.inheritBaseSkills !== false,
    excludeBaseSkills: config?.excludeBaseSkills || [],
    active: !!activeRole && RoleResolver.normalizeRoleName(activeRole) === RoleResolver.normalizeRoleName(resolvedRoleName),
    path: fs.existsSync(rolePath) ? rolePath : null,
    roleSkillCount: roleSkills.length,
    roleSkills,
    removable: fs.existsSync(rolePath),
  };
}

function listRoleOwnedSkills(rolePath: string): any[] {
  const skillsPath = path.join(rolePath, 'skills');
  if (!fs.existsSync(skillsPath)) {
    return [];
  }

  const results: any[] = [];
  for (const filePath of findSkillMdFiles(skillsPath)) {
    try {
      const skill = SkillParser.parse(filePath);
      results.push({
        name: skill.metadata.name,
        aliases: skill.metadata.aliases || [],
        description: skill.metadata.description,
        path: filePath,
      });
    } catch {
      // 单个 skill 解析失败不影响角色列表。
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function findSkillMdFiles(basePath: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(basePath)) {
    return results;
  }

  for (const entry of fs.readdirSync(basePath, { withFileTypes: true })) {
    const fullPath = path.join(basePath, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSkillMdFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      results.push(fullPath);
    }
  }

  return results;
}

async function withTemporaryRole<T>(roleName: string, fn: () => Promise<T>): Promise<T> {
  const previous = {
    XIAOBA_ROLE: process.env.XIAOBA_ROLE,
    CURRENT_ROLE: process.env.CURRENT_ROLE,
    CURRENT_ROLE_DISPLAY_NAME: process.env.CURRENT_ROLE_DISPLAY_NAME,
  };

  try {
    if (!roleName || ['base', 'default', 'none'].includes(RoleResolver.normalizeRoleName(roleName))) {
      RoleResolver.clearActiveRole();
    } else {
      RoleResolver.activateRole(roleName);
    }
    return await fn();
  } finally {
    restoreEnvValue('XIAOBA_ROLE', previous.XIAOBA_ROLE);
    restoreEnvValue('CURRENT_ROLE', previous.CURRENT_ROLE);
    restoreEnvValue('CURRENT_ROLE_DISPLAY_NAME', previous.CURRENT_ROLE_DISPLAY_NAME);
  }
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

interface DashboardSkillSummary {
  name: string;
  aliases: string[];
  description: string;
  argumentHint: string | null;
  userInvocable: boolean;
  autoInvocable: boolean;
  maxTurns: number | null;
  path: string;
  roleOwned: boolean;
  files: string[];
}

function toDashboardSkillSummary(skill: Skill): DashboardSkillSummary {
  return {
    name: skill.metadata.name,
    aliases: skill.metadata.aliases || [],
    description: skill.metadata.description,
    argumentHint: skill.metadata.argumentHint || null,
    userInvocable: skill.metadata.userInvocable !== false,
    autoInvocable: skill.metadata.autoInvocable !== false,
    maxTurns: skill.metadata.maxTurns || null,
    path: skill.filePath,
    roleOwned: skill.filePath.includes(`${path.sep}roles${path.sep}`),
    files: getSkillFiles(skill.filePath),
  };
}

function isDashboardHiddenSkillName(name: string): boolean {
  return DASHBOARD_HIDDEN_SKILLS.has(normalizeSkillLookupName(name));
}

function isDashboardHiddenSkill(summary: DashboardSkillSummary): boolean {
  if (isDashboardHiddenSkillName(summary.name)) {
    return true;
  }
  const parentDir = path.basename(path.dirname(summary.path || ''));
  return parentDir ? isDashboardHiddenSkillName(parentDir) : false;
}

function findEnabledBaseSkillsForDashboard(): DashboardSkillSummary[] {
  return PathResolver.findSkillFiles(PathResolver.getBaseSkillsPath())
    .map(skillFile => {
      try {
        return toDashboardSkillSummary(SkillParser.parse(skillFile));
      } catch {
        return null;
      }
    })
    .filter((summary): summary is DashboardSkillSummary => {
      return summary !== null && !isDashboardHiddenSkill(summary);
    });
}

function validateInstalledSkills(skillRoot: string): string[] {
  const skillFiles = PathResolver.findSkillFiles(skillRoot);
  if (skillFiles.length === 0) {
    fs.rmSync(skillRoot, { recursive: true, force: true });
    throw new Error('安装包中没有找到有效的 SKILL.md');
  }
  const skills = skillFiles.map(filePath => SkillParser.parse(filePath));
  return skills.map(skill => skill.metadata.name);
}

function normalizeSkillLookupName(value: string): string {
  return value.trim().toLowerCase();
}
