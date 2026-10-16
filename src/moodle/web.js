import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MoodleClient } from './client.js';
import { invokeTool } from './tools.js';
import { launchConfig } from './setup.js';

const ROOT = new URL('../../web/', import.meta.url);
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

export function createWebServer(client = new MoodleClient()) {
  return http.createServer(async (req, res) => {
    const host = req.headers.host;
    const origin = `http://${host}`;
    if (!/^127\.0\.0\.1:\d+$/.test(host || '') || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end('仅允许本机同源请求。'); return;
    }
    const url = new URL(req.url, origin);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(fileURLToPath(new URL(file, ROOT)))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let identity;
        try { identity = await client.status(); }
        catch (e) { identity = { connected: false, error: e.message }; }
        json(200, { ...identity, site: client.base, downloads: client.downloads, loginPending: !!client.session.pending, loginStatus: client.session.loginStatus, loginError: client.session.lastLoginError, mcp: { mcpServers: { 'xjtlu-core': launchConfig() } } }); return;
      }
      if (req.method !== 'POST' || req.headers['x-xjtlu-local'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) { json(404, { error: '接口不存在。' }); return; }
      let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 16384) { json(413, { error: '请求太大。' }); return; } }
      let data; try { data = JSON.parse(body || '{}'); } catch { json(400, { error: '请求必须是 JSON。' }); return; }
      if (url.pathname === '/api/login') {
        if (!client.session.pending) client.session.login().catch(() => {});
        json(202, { message: '请在独立的学校登录窗口完成认证。' }); return;
      }
      if (url.pathname === '/api/tool') { json(200, { result: await invokeTool(client, data.name, data.args) }); return; }
      json(404, { error: '接口不存在。' });
    } catch (e) { json(e.code === 'LOGIN_REQUIRED' ? 401 : 400, { error: e.name === 'ZodError' ? '参数不正确，请检查课程 ID 或链接。' : e.message }); }
  });
}

export async function startWeb({ port = 3891, client } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 的整数。');
  const server = createWebServer(client);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  process.stderr.write(`本地管理页面：http://127.0.0.1:${server.address().port}\n关闭终端或按 Ctrl+C 停止。\n`);
  return server;
}
