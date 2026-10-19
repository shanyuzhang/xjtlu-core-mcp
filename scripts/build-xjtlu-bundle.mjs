import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const selected = ['bin', 'src', 'web', 'scripts/install-xjtlu.mjs', 'package.json', 'package-lock.json', 'LICENSE', 'README-XJTLU.md', 'START-MAC.command', 'START-WINDOWS.cmd'];
const files = [];
function add(relative) {
  const absolute = path.join(root, relative); const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`不打包符号链接：${relative}`);
  if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) add(`${relative}/${name}`);
  else files.push({ name: `xjtlu-core-mcp/${relative}`, buffer: fs.readFileSync(absolute), executable: relative.endsWith('.command') || relative.startsWith('bin/') });
}
for (const item of selected) add(item);
const manifest = files.map((f) => ({ path: f.name, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex') }));
files.push({ name: 'xjtlu-core-mcp/BUNDLE-MANIFEST.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2)), executable: false });

// ZIP32, DEFLATE, UTF-8 names, fixed timestamp; preserve executable bits on Unix.
const table = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = (buffer) => { let crc = 0xffffffff; for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
const local = []; const central = []; let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name); const compressed = deflateRawSync(file.buffer); const crc = crc32(file.buffer);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(file.buffer.length, 22); header.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(file.buffer.length, 24); entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
  local.push(header, name, compressed); central.push(entry, name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]);
const sha = crypto.createHash('sha256').update(zip).digest('hex');
const site = (process.env.XJTLU_SITE || 'https://shanyuzhang.com/xjtlu-core-mcp').replace(/\/$/, '');
const template = fs.readFileSync(path.join(root, 'docs/xjtlu-guide.template.html'), 'utf8');
const html = template.replaceAll('__SITE__', site).replaceAll('__BUNDLE_SHA256__', sha).replaceAll('__FILE_COUNT__', String(files.length)).replaceAll('__BUILD_DATE__', new Date().toISOString().slice(0, 10));
// Windows PowerShell 5.1 的 irm 在服务器未声明 charset 时按 Latin-1 解码，中文会乱码。
// 所以发布的 install.ps1 只含 ASCII：可读源码以 UTF-8 Base64 内嵌，运行时解码执行。
const ps1 = fs.readFileSync(path.join(root, 'scripts/bootstrap/install.ps1'));
const ps1Wrapped = `# XJTLU course assistant installer for Windows. Readable source: scripts/bootstrap/install.ps1 in\r\n`
  + `# https://github.com/shanyuzhang/xjtlu-core-mcp . Embedded as UTF-8 Base64 so Windows PowerShell 5.1 shows Chinese text correctly.\r\n`
  + `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${ps1.toString('base64')}')))\r\n`;
const siteDir = path.join(dist, 'site');
fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });
const out = {
  'index.html': html, 'install.sh': fs.readFileSync(path.join(root, 'scripts/bootstrap/install.sh')), 'install.ps1': ps1Wrapped,
  'xjtlu-core-mcp.zip': zip, 'SHA256SUMS.txt': `${sha}  xjtlu-core-mcp.zip\n`, '.nojekyll': '',
};
for (const [name, value] of Object.entries(out)) fs.writeFileSync(path.join(siteDir, name), value);
// 网站图标（PNG / ICO），引用地址见 docs/xjtlu-guide.template.html 的 <link rel="icon">。
fs.cpSync(path.join(root, 'docs/icons'), path.join(siteDir, 'icons'), { recursive: true });
fs.writeFileSync(path.join(dist, 'xjtlu-core-mcp.zip'), zip);
fs.writeFileSync(path.join(dist, 'xjtlu-core-guide.html'), html);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${sha}  xjtlu-core-mcp.zip\n`);
console.log(`已生成 ${files.length} 个文件的工具包、学生指南和一行安装脚本：\n${dist}/xjtlu-core-guide.html\n${siteDir}/（GitHub Pages：${site}）\nSHA-256: ${sha}`);
