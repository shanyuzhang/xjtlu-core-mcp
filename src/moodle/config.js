import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 默认连当前学年站点；25-26 学年归档站仍可用 --url 指定。
export const DEFAULT_URL = 'https://core.xjtlu.edu.cn';
export const ARCHIVE_URL = 'https://core-archive25-26.xjtlu.edu.cn';
export const DATA_DIR = process.env.XJTLU_MCP_HOME || path.join(os.homedir(), '.xjtlu-session-mcp');
export const STATE_FILE = path.join(DATA_DIR, 'session.json');
// 旧的 browser-profile 曾由自动化浏览器访问学校认证中心，网关会给它发放被标记的持久 Cookie，
// 之后即使用普通 Chrome 打开也返回 HTTP 400。新目录只用于普通 Chrome 登录和不访问认证中心的无头检查。
export const PROFILE_DIR = path.join(DATA_DIR, 'login-browser');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('本地配置无法读取，请检查 config.json。'); }
}

export function secureJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function configure(patch) { secureJson(CONFIG_FILE, { ...readConfig(), ...patch }); }

export function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('学校地址不能包含凭据、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('学校地址必须使用 HTTPS。');
  }
  return url.origin;
}

export function settings() {
  const config = readConfig();
  return {
    base: normalizeOrigin(process.env.XJTLU_URL || config.base || DEFAULT_URL),
    downloads: path.resolve(process.env.XJTLU_MCP_DOWNLOADS || config.downloads || path.join(os.homedir(), 'Documents', 'XJTLU Core')),
  };
}
