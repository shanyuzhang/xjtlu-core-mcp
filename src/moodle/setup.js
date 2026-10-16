import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ID = 'xjtlu-core';
const toml = (s) => JSON.stringify(s);

export function launchConfig(root = ROOT) { return { command: process.execPath, args: [path.join(root, 'bin', 'xjtlu-cli.js'), 'serve'] }; }

export function upsertMoodleToml(text, launch) {
  const section = `[mcp_servers.${ID}]\ncommand = ${toml(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  const re = /^\[mcp_servers\.xjtlu-core(?:\.[^\]]+)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm;
  return text.replace(re, '').trimEnd() + `\n\n${section}`;
}

export function targets(home = os.homedir(), platform = process.platform) {
  const desktop = platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude') : path.join(home, '.config', 'Claude');
  return [
    { id: 'codex', name: 'Codex', file: path.join(home, '.codex', 'config.toml'), detect: path.join(home, '.codex'), format: 'toml' },
    { id: 'claude-desktop', name: 'Claude Desktop', file: path.join(desktop, 'claude_desktop_config.json'), detect: desktop, format: 'json' },
    { id: 'cursor', name: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), detect: path.join(home, '.cursor'), format: 'json' },
    { id: 'windsurf', name: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), detect: path.join(home, '.codeium', 'windsurf'), format: 'json' },
  ].filter((t) => fs.existsSync(t.detect));
}

export function installTarget(target, launch) {
  const prior = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
  let next;
  if (target.format === 'toml') next = upsertMoodleToml(prior, launch);
  else {
    let config;
    try { config = prior.trim() ? JSON.parse(prior) : {}; }
    catch { throw new Error(`${target.file} 不是有效 JSON，未修改。`); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('客户端配置必须是 JSON 对象。');
    config.mcpServers = { ...config.mcpServers, [ID]: launch };
    next = JSON.stringify(config, null, 2) + '\n';
  }
  const backup = `${target.file}.before-xjtlu-${Date.now()}.bak`;
  if (fs.existsSync(target.file)) fs.copyFileSync(target.file, backup, fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, next);
  return { file: target.file, backup: prior ? backup : null };
}

// npm 在 Windows 上是 .cmd 包装脚本，Node 只能通过 shell 启动；shell 只接受一整条命令行，
// 所以与 src/setup.js 相同：每个参数加引号后拼接（参考仓库提交 60065e6）。
const q = (a) => (process.platform === 'win32' ? `"${String(a).replace(/"/g, '""')}"` : `'${String(a).replace(/'/g, "'\\''")}'`);
const sh = (cmd, args, opts = {}) => spawnSync([cmd, ...args.map(q)].join(' '), { shell: true, ...opts });

export function stableInstall(log = () => {}) {
  const root = path.join(DATA_DIR, 'app');
  if (path.resolve(ROOT) === path.resolve(root)) return launchConfig(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of ['src', 'bin', 'web', 'package.json', 'package-lock.json', 'LICENSE']) {
    const source = path.join(ROOT, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(root, name), { recursive: true });
  }
  log('正在安装运行依赖到独立的本地目录…');
  const args = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
  const result = sh('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('依赖安装失败，请检查 Node.js、npm 和网络后重试。');
  return launchConfig(root);
}
