import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = process.env.XJTLU_MCP_HOME || path.join(os.homedir(), '.xjtlu-session-mcp');
const installed = path.join(data, 'app');
const run = (command, args, cwd) => {
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') });
  if (r.error || r.status !== 0) throw new Error('命令运行失败。请检查上方提示，修复网络或环境后重试。');
};
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本，请先从 https://nodejs.org 安装 LTS 版本。');
  console.log('西浦课程 MCP 安装向导\n工具代码将安装到：' + installed + '\n不会要求你把学校密码输入终端。\n');
  fs.mkdirSync(installed, { recursive: true, mode: 0o700 });
  if (path.resolve(root) !== path.resolve(installed)) {
    for (const item of ['bin', 'src', 'web', 'package.json', 'package-lock.json', 'LICENSE', 'README-XJTLU.md']) {
      fs.cpSync(path.join(root, item), path.join(installed, item), { recursive: true });
    }
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
  run(process.execPath, [path.join(installed, 'bin', 'xjtlu-cli.js'), 'setup', '--no-install', ...process.argv.slice(2)], installed);
  console.log('\n安装向导已结束。请重启刚才选择的 AI 客户端。\n本地管理页面可用命令启动：\nnode "' + path.join(installed, 'bin', 'xjtlu-cli.js') + '" web');
} catch (e) { console.error('\n安装未完成：' + e.message); process.exitCode = 1; }
