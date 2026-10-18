import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = process.env.XJTLU_MCP_HOME || path.join(os.homedir(), '.xjtlu-session-mcp');
const installed = path.join(data, 'app');
// npm 在 Windows 上是 .cmd 包装脚本，Node 只能通过 shell 启动；shell 只接受一整条命令行，
// 所以与 src/setup.js 相同：每个参数加引号后拼接（参考仓库提交 60065e6）。
const q = (a) => (process.platform === 'win32' ? `"${String(a).replace(/"/g, '""')}"` : `'${String(a).replace(/'/g, "'\\''")}'`);
const sh = (cmd, args, opts = {}) => spawnSync([cmd, ...args.map(q)].join(' '), { shell: true, ...opts });
const run = (command, args, cwd) => {
  const r = command === 'npm' ? sh(command, args, { cwd, stdio: 'inherit' }) : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) throw new Error('命令运行失败。请检查上方提示，修复网络或环境后重试。');
};
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本，请先从 https://nodejs.org 安装 LTS 版本。');
  console.log('西浦课程助手 · 安装\n安装位置：' + installed + '\n不会要求你在这里输入学校密码。\n');
  fs.mkdirSync(installed, { recursive: true, mode: 0o700 });
  if (path.resolve(root) !== path.resolve(installed)) {
    // npm 发布的包里没有 package-lock.json，而是 npm-shrinkwrap.json；两者都按存在与否复制，npm ci 都能用。
    for (const item of ['bin', 'src', 'web', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'LICENSE', 'README-XJTLU.md']) {
      if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(installed, item), { recursive: true });
    }
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
  run(process.execPath, [path.join(installed, 'bin', 'xjtlu-cli.js'), 'setup', '--no-install', ...process.argv.slice(2)], installed);
  if (!process.argv.includes('--quick')) console.log('\n安装向导已结束。请重启刚才选择的 AI 客户端。\n本地管理页面可用命令启动：\nnode "' + path.join(installed, 'bin', 'xjtlu-cli.js') + '" web');
} catch (e) { console.error('\n安装未完成：' + e.message); process.exitCode = 1; }
