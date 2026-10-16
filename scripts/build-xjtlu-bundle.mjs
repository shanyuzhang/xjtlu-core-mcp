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
const template = fs.readFileSync(path.join(root, 'docs/xjtlu-guide.template.html'), 'utf8');
const html = template.replace('__BUNDLE_BASE64__', zip.toString('base64')).replace('__BUNDLE_SHA256__', sha).replace('__FILE_COUNT__', String(files.length)).replace('__BUILD_DATE__', new Date().toISOString().slice(0, 10));
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'xjtlu-core-mcp.zip'), zip);
fs.writeFileSync(path.join(dist, 'xjtlu-core-guide.html'), html);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${sha}  xjtlu-core-mcp.zip\n`);
console.log(`已生成 ${files.length} 个文件的工具包与内置 ZIP 的独立 HTML 指南：\n${dist}/xjtlu-core-guide.html\n${dist}/xjtlu-core-mcp.zip\nSHA-256: ${sha}`);
