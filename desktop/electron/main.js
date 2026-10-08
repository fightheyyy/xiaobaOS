const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DASHBOARD_PORT = 3800;
const DEFAULT_BUNDLED_ROLES = ['user-cat', 'inspector-cat', 'engineer-cat', 'reviewer-cat', 'browser-cat', 'gui-cat', 'secretary-cat', 'evolution-cat'];
const RETIRED_AGENT_BROWSER_SKILL_SHA256S = new Set([
  '59bb1b5a07351f7b1940632695f3042afeef3268a06d03e1fbc3d85b91115648',
  '26f30428a5cff69f396e821cb51060db1f13c7ec66473268b3731001ea63cd93',
]);
const RETIRED_BASE_SKILL_FILES = {
  remember: {
    'SKILL.md': '1d75e06fa8d340ae8600e1a352923ddc6c1bf009820a4bfd1f9527b2b822661d',
    'remember.py': '5e8d8ef1a87a982650aa0bb048d8fffbd84ef8e6ad8a9f399118355b65eb2d8b',
  },
  'role-publish': {
    'SKILL.md': '50ba049c22f3acc29f08ddba40c59ab28dda6eca52feb2f2f31187e15aaa5209',
  },
  'self-evolution': {
    'SKILL.md': '6cf6c659c016eaac615e394f0cff3a889b89e28c01b10ecc2df78c468cb46dd1',
  },
  'skill-publish': {
    'SKILL.md': 'df7eb5741a9bbc5f5ed89ac90f5aec041920985a3772f9d5c24cbc4e1ddaec4a',
  },
};
const LEGACY_ROLE_CONFIG_SHA256S = {
  'user-cat': ['b4b5067d48a4a68f7dbc66a278add5fec6ee8b24ce8e7f1f0fc596a38c8bb30e'],
  'inspector-cat': ['0a6070c07f7d9a58f5cdca38534dc88426e65eed06cc39e265ec0e9de59c2b84'],
  'reviewer-cat': ['0a543e99c6f678b358af30e93de180ad7f6cc7d698c6e5f32c5cd9c5cee29fcd'],
  'engineer-cat': ['0b1582cbeac08d38f169873bf3c617a9dbad86e22ef527e8028ad486092ed835'],
  'browser-cat': [
    '011fd179328b55cc375d3ef62794786369a05213d64e735be92ec4c56c7b2c46',
    'db5c1aa2d1bc88c8f7cca7894ac44edf95ddedaefe1b1b4f9b8d480269139faa',
  ],
  'gui-cat': [
    '507bb834c6814ee30a5f7e883e6bd622c40fd97dfc8119804683d9b309656b75',
    '897c0e339735ac1efb40ecb0dd5f2808d03ac549dd19c6f83f8922d0c98be816',
  ],
  'secretary-cat': ['c973a78c9e5f80b3f6715568b4b664346ae63d8ce44a0986d3df206a00e752e2'],
  'evolution-cat': ['d44340e34419f00a4775d5ae13b5f7a1ca3577b8c4b509c859733d22495c66e3'],
};
let mainWindow = null;
let tray = null;
let autoUpdater = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.log('XiaoBa Dashboard 已在运行，退出重复启动实例。');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) {
      openDashboardPage();
      return;
    }
    app.once('ready', () => openDashboardPage());
  });
}

function getAppRoot() {
  // asar 已关闭
  // 打包后: Resources/app/desktop/electron/main.js -> Resources/app/
  // 开发时: desktop/electron/main.js -> ./
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.join(__dirname, '..', '..');
}

/**
 * Desktop Preview resolves an absolute system Node path because Finder does not load shell PATH setup.
 */
function getNodeExePath() {
  const explicit = String(process.env.XIAOBA_NODE_EXE || '').trim();
  const pathCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
  const candidates = [
    explicit,
    ...pathCandidates,
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : []),
  ].filter(Boolean);
  const requiredVersion = getRequiredNodeVersion();

  for (const candidate of [...new Set(candidates)]) {
    const resolved = path.resolve(candidate);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      const version = String(execFileSync(resolved, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
      })).trim();
      const actual = version.replace(/^v/, '').split('.').map(Number);
      const sufficient = actual[0] > requiredVersion[0] || actual[0] === requiredVersion[0] && (actual[1] > requiredVersion[1] || actual[1] === requiredVersion[1] && actual[2] >= requiredVersion[2]);
      if (sufficient) {
        return resolved;
      }
    } catch {}
  }

  console.warn(`Node.js ${requiredVersion.join('.')}+ was not resolved for desktop child services. Set XIAOBA_NODE_EXE to an absolute executable path.`);
  return 'node';
}

function getRequiredNodeVersion() {
  try {
    const engine = require(path.join(getAppRoot(), 'package.json')).engines?.node || '>=22.12.0';
    return String(engine).match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number);
  } catch {
    return [22, 12, 0];
  }
}

/**
 * 获取 node_modules 路径（打包版在 extraResources 中）
 */
function getNodeModulesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node_modules');
  }
  return path.join(__dirname, '..', '..', 'node_modules');
}

function retireExactLegacyBaseSkills(fs, skillsPath, userDataPath) {
  for (const [skillName, expectedFiles] of Object.entries(RETIRED_BASE_SKILL_FILES)) {
    const skillDir = path.join(skillsPath, skillName);
    if (!fs.existsSync(skillDir)) continue;

    const entries = fs.readdirSync(skillDir, { withFileTypes: true });
    const installedFileNames = entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
    const expectedFileNames = Object.keys(expectedFiles).sort();
    const hasOnlyExpectedFiles = entries.every(entry => entry.isFile())
      && installedFileNames.length === expectedFileNames.length
      && installedFileNames.every((fileName, index) => fileName === expectedFileNames[index]);
    if (!hasOnlyExpectedFiles) continue;

    const exactMatch = expectedFileNames.every(fileName => (
      crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(skillDir, fileName)))
        .digest('hex') === expectedFiles[fileName]
    ));
    if (!exactMatch) continue;

    const backupRoot = path.join(userDataPath, 'migration-backups', 'base-skills', skillName);
    const backupPath = path.join(backupRoot, `retired-${Date.now()}`);
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.cpSync(skillDir, backupPath, { recursive: true });
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
}

async function startServer() {
  const appRoot = getAppRoot();

  // 设置工作目录（打包后用userData存放用户数据）
  const userDataPath = app.getPath('userData');
  process.chdir(userDataPath);

  // 如果userData里没有.env，从app里复制.env.example
  const envPath = path.join(userDataPath, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(appRoot, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
    }
  }

  // 同步内置 skills 到 userData（保留用户安装的 skills）
  const skillsPath = path.join(userDataPath, 'skills');
  const bundledSkills = path.join(appRoot, 'skills');

  // EvolutionCat now owns evolution workflows and deterministic memory. Retire
  // only byte-identical legacy Base Skills; preserve any customized copy.
  retireExactLegacyBaseSkills(fs, skillsPath, userDataPath);

  // BrowserCat now owns browser routing. Retire only exact XiaoBa-built copies of
  // the old Base agent-browser Skill; preserve any user-customized Skill.
  const retiredBrowserSkillDir = path.join(skillsPath, 'agent-browser');
  const retiredBrowserSkillPath = path.join(retiredBrowserSkillDir, 'SKILL.md');
  if (fs.existsSync(retiredBrowserSkillPath)) {
    const installedHash = crypto.createHash('sha256')
      .update(fs.readFileSync(retiredBrowserSkillPath))
      .digest('hex');
    if (RETIRED_AGENT_BROWSER_SKILL_SHA256S.has(installedHash)) {
      const backupRoot = path.join(userDataPath, 'migration-backups', 'agent-browser');
      const backupPath = path.join(backupRoot, `retired-${Date.now()}`);
      fs.mkdirSync(backupRoot, { recursive: true });
      fs.cpSync(retiredBrowserSkillDir, backupPath, { recursive: true });
      fs.rmSync(retiredBrowserSkillDir, { recursive: true, force: true });
    }
  }

  if (fs.existsSync(bundledSkills)) {
    fs.mkdirSync(skillsPath, { recursive: true });

    // 复制每个内置 skill（不覆盖已存在的）
    const bundledSkillDirs = fs.readdirSync(bundledSkills, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of bundledSkillDirs) {
      const src = path.join(bundledSkills, dir.name);
      const dest = path.join(skillsPath, dir.name);

      if (!fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
      }
    }

    // 复制 README
    const readmeSrc = path.join(bundledSkills, 'README.md');
    const readmeDest = path.join(skillsPath, 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, readmeDest);
    }
  }

  // 同步内置 roles 到 userData（保留用户安装的 roles）
  const rolesPath = path.join(userDataPath, 'roles');
  const bundledRoles = path.join(appRoot, 'roles');

  if (fs.existsSync(bundledRoles)) {
    fs.mkdirSync(rolesPath, { recursive: true });

    for (const roleName of DEFAULT_BUNDLED_ROLES) {
      const src = path.join(bundledRoles, roleName);
      const dest = path.join(rolesPath, roleName);

      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true });
        continue;
      }

      // Existing built-in role directories are normally user-owned. Migrate only
      // exact role.json versions previously shipped by XiaoBa, and update the
      // bundled petId without replacing prompts, skills, or any other role files.
      const bundledRoleConfigPath = path.join(src, 'role.json');
      const installedRoleConfigPath = path.join(dest, 'role.json');
      const legacyRoleConfigSha256s = LEGACY_ROLE_CONFIG_SHA256S[roleName] || [];
      if (legacyRoleConfigSha256s.length
        && fs.existsSync(bundledRoleConfigPath)
        && fs.existsSync(installedRoleConfigPath)
        && legacyRoleConfigSha256s.includes(crypto.createHash('sha256')
          .update(fs.readFileSync(installedRoleConfigPath))
          .digest('hex'))) {
        const bundledRoleConfig = JSON.parse(fs.readFileSync(bundledRoleConfigPath, 'utf8'));
        const installedRoleConfig = JSON.parse(fs.readFileSync(installedRoleConfigPath, 'utf8'));
        installedRoleConfig.metadata = {
          ...installedRoleConfig.metadata,
          petId: bundledRoleConfig.metadata.petId,
        };
        fs.writeFileSync(installedRoleConfigPath, `${JSON.stringify(installedRoleConfig, null, 2)}\n`);
      }
    }

    const readmeSrc = path.join(bundledRoles, 'README.md');
    const readmeDest = path.join(rolesPath, 'README.md');
    if (fs.existsSync(readmeSrc)) {
      fs.copyFileSync(readmeSrc, readmeDest);
    }
  }

  // 每次启动都更新 skill-registry.json（确保用户获得最新的本地索引）
  const registryDest = path.join(userDataPath, 'skill-registry.json');
  const registrySrc = path.join(appRoot, 'skill-registry.json');
  if (fs.existsSync(registrySrc)) {
    fs.copyFileSync(registrySrc, registryDest);
  }

  // 复制 prompts 目录
  const promptsDest = path.join(userDataPath, 'prompts');
  const promptsSrc = path.join(appRoot, 'prompts');
  if (!fs.existsSync(promptsDest) && fs.existsSync(promptsSrc)) {
    fs.cpSync(promptsSrc, promptsDest, { recursive: true });
  }

  // 加载dotenv；Dashboard 配置页写入的 userData/.env 应作为 Electron 运行时配置源。
  process.env.DOTENV_CONFIG_PATH = envPath;
  process.env.DOTENV_CONFIG_OVERRIDE = 'true';
  require('dotenv').config({ path: envPath, quiet: true, override: true });

  // 告诉 dashboard server app 的实际位置（asar 内）
  process.env.XIAOBA_APP_ROOT = appRoot;

  // 打包版：设置 NODE_PATH 让子进程能找到 node_modules
  const nodeModulesPath = getNodeModulesPath();
  process.env.XIAOBA_NODE_MODULES = nodeModulesPath;
  if (app.isPackaged) {
    process.env.NODE_PATH = nodeModulesPath;
    require('module').Module._initPaths();
  }

  // ConfigManager reloads the same .env while the Dashboard module is imported.
  const { startDashboard } = require(path.join(appRoot, 'dist', 'dashboard', 'server'));
  process.env.XIAOBA_NODE_EXE = getNodeExePath();
  await startDashboard(DASHBOARD_PORT, undefined, { onNavigate: openDashboardPage });
}

function getDashboardUrl(page) {
  const url = new URL(process.env.XIAOBA_DASHBOARD_URL || `http://127.0.0.1:${DASHBOARD_PORT}`);
  if (page) url.searchParams.set('page', page);
  return url.toString();
}

function createWindow(page) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'XiaoBa Dashboard',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f8f7f3',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === 'https://accounts.google.com' && target.pathname === '/o/oauth2/v2/auth') {
        void shell.openExternal(target.toString()).catch(() => {});
        return { action: 'deny' };
      }
    } catch {}
    return { action: 'allow' };
  });

  mainWindow.loadURL(getDashboardUrl(page));

  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openDashboardPage(page) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(page);
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();

  if (!page) return;

  const script = `if (window.switchPage) { window.switchPage(${JSON.stringify(page)}); true } else false;`;
  mainWindow.webContents.executeJavaScript(script)
    .then(ok => {
      if (!ok) mainWindow.loadURL(getDashboardUrl(page));
    })
    .catch(() => {
      mainWindow.loadURL(getDashboardUrl(page));
    });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c6xDQAgDASwkP2XZgEqCgrZwJ+u8Ov1vt+RM0EHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx100EEHHXTQQQcddNBBBx3834kDK+kAIRUXPjcAAAAASUVORK5CYII='
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 Dashboard', click: () => {
      openDashboardPage();
    }},
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); }},
  ]);

  tray.setToolTip('XiaoBa Dashboard');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    openDashboardPage();
  });
}

function initializeAutoUpdater() {
  if (!app.isPackaged || process.env.XIAOBA_ENABLE_AUTO_UPDATE !== 'true') {
    return null;
  }

  try {
    const updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on('error', error => console.error('Auto-update error:', error));
    updater.on('update-available', (info) => {
      dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${info.version}，是否下载？`,
        buttons: ['下载', '稍后'],
      }).then((result) => {
        if (result.response === 0) {
          Promise.resolve(updater.downloadUpdate())
            .catch(error => console.error('Auto-update download failed:', error));
        }
      });
    });
    updater.on('update-downloaded', () => {
      dialog.showMessageBox({
        type: 'info',
        title: '更新已下载',
        message: '更新已下载完成，重启应用后生效',
        buttons: ['立即重启', '稍后'],
      }).then((result) => {
        if (result.response === 0) updater.quitAndInstall();
      });
    });
    return updater;
  } catch (error) {
    console.error('electron-updater unavailable:', error);
    return null;
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  try {
    await startServer();
    autoUpdater = initializeAutoUpdater();
    createWindow();
    createTray();

    if (autoUpdater) {
      setTimeout(() => {
        Promise.resolve(autoUpdater.checkForUpdates())
          .catch(error => console.error('Auto-update check failed:', error));
      }, 3000);
    }
  } catch (err) {
    console.error('启动失败:', err);
    app.quit();
  }

  app.on('activate', () => {
    openDashboardPage();
  });
});

app.on('window-all-closed', () => {
  if (!gotSingleInstanceLock) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
