#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { settings, configure, normalizeOrigin, DATA_DIR } from '../src/moodle/config.js';
import { MoodleClient } from '../src/moodle/client.js';
import { launchConfig, stableInstall, targets, installTarget } from '../src/moodle/setup.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: 'string' }, downloads: { type: 'string' }, port: { type: 'string', default: '3891' },
  yes: { type: 'boolean' }, 'no-login': { type: 'boolean' }, 'no-install': { type: 'boolean' }, clients: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });
const command = values.help ? 'help' : positionals[0] || 'serve';
const log = (s) => process.stderr.write(s + '\n');
let rl;
const ask = async (text, fallback = '') => {
  if (!process.stdin.isTTY) return fallback;
  rl ||= readline.createInterface({ input: process.stdin, output: process.stderr });
  return (await rl.question(`${text}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
};

try {
  if (command === 'help') log(`西浦 Learning Mall MCP\n\n  setup         连接学校账号并配置 AI 客户端\n  login         在独立 Chrome / Edge 窗口登录\n  status        检查登录状态\n  serve         启动 MCP（默认，供 AI 客户端调用）\n  web           启动本地管理页面 http://127.0.0.1:3891\n  config        输出手动 MCP 配置\n\n可选 --url https://core-archive25-26.xjtlu.edu.cn --downloads <目录> --port 3891\n数据目录：${DATA_DIR}`);
  else if (command === 'setup') {
    if (!process.stdin.isTTY && !values.yes) throw new Error('非交互安装需要 --yes 和明确的 --clients；日常使用请在终端运行 setup。');
    const base = normalizeOrigin(values.url || await ask('学校地址（AY25/26 归档站）', settings().base));
    const downloads = path.resolve(values.downloads || await ask('课件保存目录', settings().downloads));
    configure({ base, downloads });
    fs.mkdirSync(downloads, { recursive: true });
    const launch = values['no-install'] ? launchConfig() : stableInstall(log);
    if (!values['no-login']) {
      log('正在打开学校登录窗口。请直接在学校页面输入账号、密码和验证码。');
      await new MoodleClient().session.login({ onProgress: log });
      log('✓ 学校账号已连接。');
    }
    const only = values.clients?.split(',');
    for (const target of targets().filter((t) => !only || only.includes(t.id))) {
      if (values.yes && !only) throw new Error('--yes 必须配合 --clients，避免修改未选择的客户端。');
      if (!values.yes && !/^(y|yes|是)$/i.test(await ask(`接入 ${target.name}？将修改 ${target.file} 并创建备份 (y/N)`, 'n'))) continue;
      const result = installTarget(target, launch);
      log(`✓ ${target.name}: ${result.file}${result.backup ? `\n  备份：${result.backup}` : ''}`);
    }
    log('安装完成。请重启已接入的 AI 客户端，询问「列出我的西浦课程」。');
    log(`手动配置：\n${JSON.stringify({ mcpServers: { 'xjtlu-core': launch } }, null, 2)}`);
  } else {
    if (values.url || values.downloads) configure({ ...(values.url ? { base: normalizeOrigin(values.url) } : {}), ...(values.downloads ? { downloads: path.resolve(values.downloads) } : {}) });
    if (command === 'serve') await (await import('../src/moodle/server.js')).startMoodleServer();
    else if (command === 'login') { log('请在 MCP 专用窗口完成登录。普通 Chrome 和 Codex 内置浏览器的登录不会自动同步到这里。'); await new MoodleClient().session.login({ onProgress: log }); log('✓ 登录状态已保存。'); }
    else if (command === 'status') log(JSON.stringify(await new MoodleClient().status(), null, 2));
    else if (command === 'config') log(JSON.stringify({ mcpServers: { 'xjtlu-core': launchConfig() } }, null, 2));
    else if (command === 'web') await (await import('../src/moodle/web.js')).startWeb({ port: Number(values.port) });
    else throw new Error('未知命令，请运行 --help。');
  }
} catch (e) { log(`✗ ${e.message}`); process.exitCode = 1; }
finally { rl?.close(); }
