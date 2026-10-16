import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { chromium } from 'playwright-core';
import { STATE_FILE, PROFILE_DIR, secureJson } from './config.js';

export class LoginRequired extends Error {
  constructor() { super('登录已失效或尚未登录。请在本地页面点击「连接学校账号」，或运行 npm run xjtlu -- login。'); this.code = 'LOGIN_REQUIRED'; }
}

export function loginResponseHint(status, body = '') {
  if ([400, 431].includes(status) && /(?:request header|cookie).{0,80}(?:too (?:large|long)|exceed)/i.test(body)) {
    return '请求头或 Cookie 过大；需要重置本工具的独立浏览器会话。';
  }
  if (/csrf|xsrf/i.test(body)) return `HTTP ${status}（站点会话校验失败）`;
  if (/(?:invalid|illegal|denied).{0,30}(?:origin|referer)|(?:origin|referer).{0,30}(?:invalid|illegal|denied)/i.test(body)) return `HTTP ${status}（站点来源校验失败）`;
  return `HTTP ${status}`;
}

// 学校认证网关（uim）会拒绝 navigator.webdriver 为 true 的浏览器：带 --enable-automation 或
// --remote-debugging-port 时，/ngw/context 和登录脚本一律 HTTP 400，表单白屏。所以可见登录窗口
// 是一个不受任何调试协议控制的普通 Chrome / Edge（独立 profile），由用户本人输入账号密码；
// 我们只读 Chrome 自带的网络日志（默认模式不含 Cookie）判断是否已回到 Moodle，再让浏览器正常退出、
// 由 Playwright 在 Moodle 域名上以无头方式读取并校验会话。
const PATHS = {
  darwin: { chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
  win32: { chrome: ['%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe', '%PROGRAMFILES%/Google/Chrome/Application/chrome.exe', '%PROGRAMFILES(X86)%/Google/Chrome/Application/chrome.exe'],
    msedge: ['%PROGRAMFILES(X86)%/Microsoft/Edge/Application/msedge.exe', '%PROGRAMFILES%/Microsoft/Edge/Application/msedge.exe', '%LOCALAPPDATA%/Microsoft/Edge/Application/msedge.exe'] },
  linux: { chrome: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'], msedge: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'] },
};

export function findBrowser(channel) {
  if (channel === 'chromium') { try { const exe = chromium.executablePath(); return fs.existsSync(exe) ? exe : null; } catch { return null; } }
  const expand = (p) => p.replace(/^~/, os.homedir()).replace(/%([^%]+)%/g, (_, name) => process.env[name] || '\0');
  return (PATHS[process.platform]?.[channel] || []).map(expand).find((p) => !p.includes('\0') && fs.existsSync(p)) || null;
}

// 逐行读取 Chrome --log-net-log 输出：第一行是常量表，之后每行一个事件。只关心请求 URL 和响应状态行。
export class NetLogWatcher {
  constructor(file) { this.file = file; this.offset = 0; this.rest = ''; this.types = null; this.urls = new Map(); }

  read() {
    let fd; try { fd = fs.openSync(this.file, 'r'); } catch { return []; }
    try {
      const { size } = fs.fstatSync(fd);
      if (size <= this.offset) return [];
      const chunk = Buffer.alloc(size - this.offset);
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
      const lines = (this.rest + chunk.toString('utf8')).split('\n');
      this.rest = lines.pop();
      const out = [];
      for (const line of lines) {
        if (!this.types) {
          if (!line.startsWith('{"constants":')) continue;
          try { const t = JSON.parse(line.slice(0, line.lastIndexOf(',')) + '}').constants.logEventTypes; this.types = { start: t.URL_REQUEST_START_JOB, headers: t.HTTP_TRANSACTION_READ_RESPONSE_HEADERS }; } catch {}
          continue;
        }
        if (!line.startsWith('{')) continue;
        let e; try { e = JSON.parse(line.replace(/,\s*$/, '')); } catch { continue; }
        if (e.type === this.types.start && e.params?.url) this.urls.set(e.source?.id, e.params.url);
        else if (e.type === this.types.headers && this.urls.has(e.source?.id)) {
          const status = Number(String(e.params?.headers?.[0] || '').split(' ')[1]);
          try { out.push({ url: new URL(this.urls.get(e.source.id)), status }); } catch {}
        }
      }
      return out;
    } finally { fs.closeSync(fd); }
  }
}

const SIGNED_IN_PATH = /^\/(?:my\/(?:index\.php|courses\.php)?|course\/view\.php)$/;
export const signedInResponse = ({ url, status }, base) => status === 200 && url.origin === base && SIGNED_IN_PATH.test(url.pathname);

const quit = (proc) => new Promise((resolve) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
  const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 15000);
  proc.once('exit', () => { clearTimeout(timer); resolve(); });
  // SIGINT / WM_CLOSE 让 Chrome 正常退出并把会话 Cookie 写入 profile；SIGTERM 在 macOS 上不会写盘。
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/t'], () => {});
  else proc.kill('SIGINT');
});

export class MoodleSession {
  constructor(base, { stateFile = STATE_FILE, profileDir = PROFILE_DIR, launchBrowser = (dir, options) => chromium.launchPersistentContext(dir, options),
    findBrowser: find = findBrowser, spawnBrowser = (exe, args) => spawn(exe, args, { stdio: 'ignore' }), pollMs = 700 } = {}) {
    this.base = base;
    this.stateFile = stateFile;
    this.profileDir = profileDir;
    this.pending = null;
    this.lastLoginError = null;
    this.loginStatus = null;
    this.launchBrowser = launchBrowser;
    this.findBrowser = find;
    this.spawnBrowser = spawnBrowser;
    this.pollMs = pollMs;
  }

  state() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('本地登录状态无法读取，请重新登录。'); }
  }

  cookieHeader(url) {
    const target = new URL(url);
    const now = Date.now() / 1000;
    return (this.state()?.cookies || []).filter((c) => {
      const host = c.domain.replace(/^\./, '');
      const domain = c.domain.startsWith('.') ? target.hostname === host || target.hostname.endsWith(`.${host}`) : target.hostname === host;
      const cookiePath = c.path || '/';
      const path = target.pathname === cookiePath || (target.pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || target.pathname[cookiePath.length] === '/'));
      return domain && path && (!c.secure || target.protocol === 'https:') && (c.expires === -1 || c.expires > now);
    }).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  updateCookies(response, url) {
    const values = response.headers.getSetCookie?.() || [];
    if (!values.length) return;
    const state = this.state() || { cookies: [], origins: [] };
    const target = new URL(url);
    for (const value of values) {
      const [pair, ...attributes] = value.split(';');
      const sep = pair.indexOf('=');
      if (sep < 1) continue;
      const c = { name: pair.slice(0, sep).trim(), value: pair.slice(sep + 1).trim(), domain: target.hostname,
        path: target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1) || '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' };
      let maxAge;
      for (const a of attributes) {
        const [key, ...rest] = a.trim().split('='); const v = rest.join('=');
        switch (key.toLowerCase()) {
          case 'domain': c.domain = v.startsWith('.') ? v : `.${v}`; break;
          case 'path': c.path = v || '/'; break;
          case 'expires': { const ms = Date.parse(v); if (Number.isFinite(ms)) c.expires = ms / 1000; break; }
          case 'max-age': if (/^-?\d+$/.test(v)) maxAge = Number(v); break;
          case 'secure': c.secure = true; break;
          case 'httponly': c.httpOnly = true; break;
          case 'samesite': if (/^(strict|lax|none)$/i.test(v)) c.sameSite = v[0].toUpperCase() + v.slice(1).toLowerCase(); break;
        }
      }
      const domain = c.domain.replace(/^\./, '');
      if (!(target.hostname === domain || target.hostname.endsWith(`.${domain}`))) continue;
      if (maxAge !== undefined) c.expires = Date.now() / 1000 + maxAge;
      state.cookies = state.cookies.filter((old) => !(old.name === c.name && old.domain.replace(/^\./, '') === domain && old.path === c.path));
      if (c.expires === -1 || c.expires > Date.now() / 1000) state.cookies.push(c);
    }
    secureJson(this.stateFile, state);
  }

  login({ headless = false, timeoutMs = headless ? 15000 : 600000, onProgress = () => {} } = {}) {
    if (this.pending) return this.pending;
    this.lastLoginError = null;
    this.pending = (headless ? this.openLogin({ headless, timeoutMs, onProgress }) : this.openManualLogin({ timeoutMs, onProgress })).catch((e) => {
      this.lastLoginError = e.message;
      this.loginStatus = '登录未完成';
      throw e;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  channels() { return process.env.XJTLU_MCP_BROWSER ? [process.env.XJTLU_MCP_BROWSER] : ['chrome', 'msedge', 'chromium']; }

  async openManualLogin({ timeoutMs, onProgress }) {
    const progress = (message) => {
      if (this.loginStatus === message) return;
      this.loginStatus = message;
      onProgress(message);
    };
    progress('正在启动 MCP 专用浏览器…');
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const channel = this.channels().find((c) => this.findBrowser(c));
    if (!channel) throw new Error('无法打开登录窗口。请安装 Chrome / Edge。');
    // 网络日志含跳转 URL（不含 Cookie），只放在私有 profile 目录里，结束后删除。
    const netlog = path.join(this.profileDir, 'login-netlog.json');
    fs.rmSync(netlog, { force: true });
    const proc = this.spawnBrowser(this.findBrowser(channel), [`--user-data-dir=${this.profileDir}`, `--log-net-log=${netlog}`,
      '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', `${this.base}/my/`]);
    let exited = false; let spawnError = null;
    proc.once('exit', () => { exited = true; });
    proc.once('error', (e) => { spawnError = e; exited = true; });
    const watcher = new NetLogWatcher(netlog);
    let signedIn = false;
    try {
      progress('浏览器已启动，正在加载学校入口…');
      const deadline = Date.now() + timeoutMs;
      while (!signedIn && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        for (const r of watcher.read()) {
          if (signedInResponse(r, this.base)) { signedIn = true; break; }
          if (r.url.origin === this.base && r.url.pathname === '/local/login/index.php') progress('学校入口已显示，请点击 XJTLU Account。');
          if (r.url.hostname === 'uim.xjtlu.edu.cn' && r.status === 200 && r.url.pathname.endsWith('/accountPsw.js')) progress('学校认证表单已显示，请在此专用窗口输入账号密码。');
          if (r.url.hostname === 'uim.xjtlu.edu.cn' && r.status === 400 && r.url.pathname === '/ngw/context') progress('学校认证网关拒绝了此窗口（HTTP 400），登录表单可能不会显示。');
        }
        if (!signedIn && exited) throw new Error(spawnError ? '无法打开登录窗口。请安装 Chrome / Edge。' : '登录窗口已关闭，请重新连接。如果此前已有一个本工具的登录窗口，请先将其关闭。');
      }
      if (!signedIn) throw new Error('等待登录超时，请重试。');
      progress('已检测到登录成功，正在保存 MCP 专用会话（窗口会自动关闭）…');
    } finally {
      await quit(proc);
      fs.rmSync(netlog, { force: true });
    }
    let context;
    try { context = await this.launchBrowser(this.profileDir, { channel, headless: true, args: ['--restore-last-session'], timeout: 20000 }); }
    catch { throw new Error('登录已完成，但无法在后台读取会话。请关闭本工具的浏览器窗口后重试。'); }
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(`${this.base}/my/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (!await page.locator('#user-menu-toggle').count()) throw new Error('登录窗口已关闭，但未读取到有效的学校会话，请重试。');
      const state = await context.storageState();
      secureJson(this.stateFile, { cookies: state.cookies, origins: [] });
      progress('MCP 专用会话已保存。');
      return { connected: true };
    } finally { await context.close().catch(() => {}); }
  }

  async openLogin({ headless, timeoutMs, onProgress }) {
    const progress = (message) => {
      if (this.loginStatus === message) return;
      this.loginStatus = message;
      onProgress(message);
    };
    progress('正在启动 MCP 专用浏览器…');
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const channels = this.channels();
    let context;
    let launchTimedOut = false;
    for (const channel of channels) {
      try { context = await this.launchBrowser(this.profileDir, { channel, headless, viewport: null, timeout: 20000 }); break; }
      catch (e) { launchTimedOut ||= e.name === 'TimeoutError'; }
    }
    if (!context) throw new Error(launchTimedOut ? '浏览器启动超时，尚未进入学校网站。请关闭本工具的空白窗口后重试；这不是学校账号登录失败。' : '无法打开登录窗口。请安装 Chrome / Edge，并确认没有其他进程使用此项目的独立浏览器配置。');
    try {
      let networkWarnings = 0;
      const warn = (request, reason) => {
        if (networkWarnings >= 5 || !['document', 'script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType())) return;
        let location; try { const u = new URL(request.url()); location = u.hostname + u.pathname.slice(0, 160); } catch { return; }
        networkWarnings++;
        onProgress(`页面资源加载异常：${location} · ${request.resourceType()} · ${reason}`);
      };
      context.on?.('requestfailed', (request) => {
        const code = request.failure()?.errorText?.match(/ERR_[A-Z_]+/)?.[0];
        if (code !== 'ERR_ABORTED') warn(request, code || 'request failed');
      });
      context.on?.('response', async (response) => {
        if (response.status() < 400) return;
        const length = Number(response.headers()['content-length']);
        let body = '';
        if (!length || length <= 16384) body = await response.text().catch(() => '');
        const headers = await response.request().allHeaders().catch(() => ({}));
        const headerBytes = Object.entries(headers).reduce((total, [key, value]) => total + Buffer.byteLength(key + value), 0);
        warn(response.request(), `${loginResponseHint(response.status(), body)} · 请求头 ${headerBytes} 字节 / Cookie ${Buffer.byteLength(headers.cookie || '')} 字节`);
      });
      const cookies = this.state()?.cookies;
      if (cookies?.length) await context.addCookies(cookies);
      const page = context.pages()[0] || await context.newPage();
      const entry = cookies?.length ? '/my/' : '/local/login/index.php';
      progress('浏览器已启动，正在加载学校入口…');
      try { await page.goto(this.base + entry, { waitUntil: 'commit', timeout: 45000 }); }
      catch { throw new Error('学校入口加载失败，请先在普通浏览器确认归档站可访问，再检查网络或代理设置。'); }
      if (!headless) await page.bringToFront();
      const deadline = Date.now() + timeoutMs;
      let startedSso = false;
      while (Date.now() < deadline) {
        const tabs = context.pages().filter((p) => !p.isClosed());
        if (!tabs.length) throw new Error('登录窗口已关闭，请重新连接。');
        for (const tab of tabs) {
          const origin = new URL(tab.url()).origin;
          if (['https://uim.xjtlu.edu.cn', 'https://sso.xjtlu.edu.cn'].includes(origin)) {
            const ready = await tab.locator('input[type="password"]').isVisible().catch(() => false);
            progress(ready ? '学校认证表单已显示，请在此专用窗口完成登录。' : '已进入学校认证中心，正在等待登录表单加载…');
          }
          if (!tab.url().startsWith(`${this.base}/`)) continue;
          // 无头浏览器带 webdriver 标记，不能进入学校认证中心，否则网关会标记此 profile；会话失效时交给可见登录。
          if (headless && new URL(tab.url()).pathname === '/local/login/index.php') throw new Error('需要手动登录，请点击「连接学校账号」。');
          if (!startedSso && new URL(tab.url()).pathname === '/local/login/index.php') {
            progress('学校入口已显示，正在进入 XJTLU Account…');
            const account = tab.getByRole('link', { name: 'XJTLU Account', exact: true });
            if (await account.count() === 1) {
              startedSso = true;
              await account.click({ timeout: 5000 });
            }
          }
          if (await tab.locator('#user-menu-toggle').count()) {
            const state = await context.storageState();
            secureJson(this.stateFile, { cookies: state.cookies, origins: [] });
            progress('MCP 专用会话已保存。');
            return { connected: true };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      throw new Error(headless ? '需要手动登录，请点击「连接学校账号」。' : '等待登录超时，请重试。');
    } finally { await context.close().catch(() => {}); }
  }
}
