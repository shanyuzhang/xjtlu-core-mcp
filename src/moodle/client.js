import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, secureJson, settings } from './config.js';
import { MoodleSession, LoginRequired, RestrictedActivity } from './session.js';
import { parseIdentity, parseCourses, parseCourse, parsePage, sessionKey, safeName } from './parse.js';
import { extractText, window } from '../text.js';

export const READ_METHODS = new Set(['core_course_get_enrolled_courses_by_timeline_classification']);
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_MB = Math.round(MAX_BYTES / 1024 / 1024);
const PAGE_PATHS = /^\/(?:my\/(?:courses\.php)?|course\/(?:view|section)\.php|mod\/(?:resource|folder|page|assign|quiz|forum|url)\/view\.php|pluginfile\.php\/[^?#]+|lib\/ajax\/service\.php)$/;

export function allowedUrl(value, base) {
  const u = new URL(value, base);
  if (u.origin !== new URL(base).origin || u.username || u.password || !PAGE_PATHS.test(u.pathname)) throw new Error('只允许读取当前学校站点的课程页面和课件。');
  for (const key of u.searchParams.keys()) if (!['id', 'redirect', 'forcedownload', 'classification', 'sesskey', 'info'].includes(key)) throw new Error('不允许此请求参数。');
  u.hash = '';
  return u;
}

async function limitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error(`文件超过 ${MAX_MB} MB 限制。`); }
  const chunks = []; let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`文件超过 ${MAX_MB} MB 限制。`); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class MoodleClient {
  constructor({ base, downloads, session, fetchImpl = fetch, dataDir = DATA_DIR } = {}) {
    const config = settings();
    this.base = base || config.base;
    this.downloads = downloads || config.downloads;
    this.session = session || new MoodleSession(this.base);
    this.fetch = fetchImpl;
    this.indexPath = path.join(dataDir, 'downloads.json');
    this.downloadQueue = Promise.resolve();
  }

  async request(value, { method = 'GET', data, renew = true } = {}) {
    if (method !== 'GET' && !(method === 'POST' && Array.isArray(data) && data.length === 1 && data.every((x) => READ_METHODS.has(x.methodname)))) throw new Error('不允许写入或未知的 Moodle 接口。');
    let url = allowedUrl(value, this.base);
    if (method === 'POST' && url.pathname !== '/lib/ajax/service.php') throw new Error('只允许已审核的读取接口。');
    if (!this.session.cookieHeader(url.href)) throw new LoginRequired();
    for (let redirect = 0; redirect < 6; redirect++) {
      const cookie = this.session.cookieHeader(url.href);
      let res;
      // 偶发的连接超时 / IPv4-IPv6 竞速会导致单次请求失败；读取是幂等的，重试一次即可大幅减少漏下载。
      for (let attempt = 0; ; attempt++) {
        try {
          res = await this.fetch(url, { method, headers: { Cookie: cookie, Accept: '*/*', ...(data ? { 'Content-Type': 'application/json' } : {}) },
            body: data ? JSON.stringify(data) : undefined, redirect: 'manual', signal: AbortSignal.timeout(45000) });
          break;
        } catch (e) {
          if (attempt >= 2) throw new Error('无法连接学校站点，请检查网络或校园 VPN。');
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      this.session.updateCookies?.(res, url.href);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const next = new URL(res.headers.get('location') || '', url);
        if (/\/(?:login|auth)\//.test(next.pathname) && next.origin === this.base) return this.expired(value, { method, data, renew });
        if (next.origin !== this.base) {
          if (['uim.xjtlu.edu.cn', 'sso.xjtlu.edu.cn'].includes(next.hostname)) return this.expired(value, { method, data, renew });
          throw new Error('资源跳转到校外或其他站点，此版本只下载当前学校站点的文件。');
        }
        // 新版站点把受限活动重定向到 /course/cms/<id>/restricted；给出明确提示而非通用白名单错误。
        if (/\/restricted\/?$/.test(next.pathname) || next.pathname.startsWith('/course/cms/')) {
          throw new RestrictedActivity();
        }
        url = allowedUrl(next.href, this.base);
        continue;
      }
      if (res.status === 401) { await res.body?.cancel(); return this.expired(value, { method, data, renew }); }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`学校站点返回 ${res.status}，可能无权限读取此内容。`); }
      const buffer = await limitedBody(res, MAX_BYTES);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html') && /(?:id=["']page-login-|name=["']logintoken["']|\/local\/login\/index\.php)/i.test(buffer.toString('utf8')) && !parseIdentity(buffer.toString('utf8'), this.base).connected) {
        return this.expired(value, { method, data, renew });
      }
      return { buffer, contentType, url: url.href, disposition: res.headers.get('content-disposition') || '', etag: res.headers.get('etag') };
    }
    throw new Error('学校站点重定向次数过多。');
  }

  async expired(value, options) {
    if (options.renew && this.session.login) {
      try { await this.session.login({ headless: true }); }
      catch { throw new LoginRequired(); }
      return this.request(value, { ...options, renew: false });
    }
    throw new LoginRequired();
  }

  async html(url) { const r = await this.request(url); if (!r.contentType.includes('html')) throw new Error('预期课程页面，但收到其他文件类型。'); return r.buffer.toString('utf8'); }

  async status() {
    const html = await this.html('/my/');
    const info = parseIdentity(html, this.base);
    if (!info.connected) throw new LoginRequired();
    return info;
  }

  async courses() {
    const html = await this.html('/my/courses.php');
    const key = sessionKey(html);
    if (key) {
      const courses = []; let offset = 0;
      for (let page = 0; page < 30; page++) {
        const result = await this.request(`/lib/ajax/service.php?sesskey=${encodeURIComponent(key)}&info=core_course_get_enrolled_courses_by_timeline_classification`, {
          method: 'POST', data: [{ index: 0, methodname: 'core_course_get_enrolled_courses_by_timeline_classification', args: { classification: 'all', limit: 100, offset, sort: 'fullname ASC' } }],
        });
        let payload;
        try { payload = JSON.parse(result.buffer.toString('utf8')); } catch { throw new Error('课程接口未返回有效 JSON。'); }
        if (!Array.isArray(payload) || payload[0]?.error || !Array.isArray(payload[0]?.data?.courses)) throw new Error('学校未开放课程读取接口，请使用 courses 的 visible_only 参数读取首页可见课程。');
        const data = payload[0].data;
        for (const c of data.courses) courses.push({ id: String(c.id), name: c.fullname || c.shortname, url: `${this.base}/course/view.php?id=${c.id}`, progress: c.progress });
        const next = Number(data.nextoffset);
        if (!Number.isFinite(next) || next <= offset) return { courses, complete: true, source: 'moodle-ajax' };
        offset = next;
      }
      return { courses, complete: false, note: '达到课程分页上限。', source: 'moodle-ajax' };
    }
    return this.visibleCourses(html);
  }

  async visibleCourses(html) {
    const courses = parseCourses(html || await this.html('/my/'), this.base);
    return { courses, complete: false, source: 'visible-page', note: '仅包含当前 HTML 中可见的课程，不代表全部已选课程。' };
  }

  async course(id) {
    const main = parseCourse(await this.html(`/course/view.php?id=${numericId(id)}`), this.base);
    const links = main.sectionLinks || [];
    if (!links.length) return { id: String(id), name: main.name, sections: main.sections, items: main.items };
    // 分页课程：逐个抓取 section.php 页面，按活动 id 去重合并，同名分节合并为一节。
    const seen = new Set();
    const byName = new Map();
    const order = [];
    const add = (section) => {
      let target = byName.get(section.name);
      if (!target) { target = { name: section.name, items: [] }; byName.set(section.name, target); order.push(target); }
      for (const it of section.items) if (!seen.has(it.id)) { seen.add(it.id); target.items.push(it); }
    };
    main.sections.forEach(add);
    let truncated = false;
    for (const link of links.slice(0, 60)) {
      try { parseCourse(await this.html(link), this.base).sections.forEach(add); }
      catch { /* 单节读取失败不影响其余分节 */ }
    }
    if (links.length > 60) truncated = true;
    const sections = order.filter((s) => s.items.length || main.sections.some((m) => m.name === s.name));
    return { id: String(id), name: main.name, sections, items: sections.flatMap((s) => s.items), ...(truncated ? { truncated: true, note: '分节数量超过上限，部分内容未读取。' } : {}) };
  }

  async activity(id, type = 'assign') {
    if (!['assign', 'quiz', 'forum', 'page', 'folder', 'resource', 'url'].includes(type)) throw new Error('不支持的活动类型。');
    const url = `/mod/${type}/view.php?id=${numericId(id)}`;
    const r = await this.request(url);
    if (!r.contentType.includes('html')) return { id: String(id), type, files: [{ name: decodeURIComponent(new URL(r.url).pathname.split('/').pop()), url: r.url }], text: '此活动直接返回文件，请调用 moodle_read_file。' };
    return { id: String(id), type, ...parsePage(r.buffer.toString('utf8'), this.base) };
  }

  async assignments(courseId) {
    const course = await this.course(courseId);
    const items = course.items.filter((it) => ['assign', 'quiz', 'turnitintooltwo', 'turnitin'].includes(it.type));
    return { course_id: String(courseId), course: course.name, items, note: '日期原样保留学校页面的时区；此接口只列出课程页可见的作业和测验。' };
  }

  async download(url, courseId) {
    const run = () => this.downloadFile(url, courseId);
    const task = this.downloadQueue.then(run, run);
    this.downloadQueue = task.catch(() => {});
    return task;
  }

  async downloadFile(value, courseId) {
    let url = allowedUrl(value, this.base);
    if (!/^\/pluginfile\.php\//.test(url.pathname) && !/^\/mod\/resource\/view\.php$/.test(url.pathname)) throw new Error('仅支持课程资源或 pluginfile 文件链接。');
    let result = await this.request(url.href);
    if (result.contentType.includes('html') && url.pathname.startsWith('/mod/resource/')) {
      // 「嵌入显示」的资源页先出现 iframe 的 ?embed=1 地址，取第一个符合白名单的文件链接。
      const allowed = parsePage(result.buffer.toString('utf8'), this.base).files.map((f) => { try { return allowedUrl(f.url, this.base); } catch { return null; } }).filter(Boolean);
      if (!allowed.length) throw new Error('此资源页面中没有可下载的文件。');
      url = allowed[0];
      result = await this.request(url.href);
    }
    if (result.contentType.includes('html') && !new URL(result.url).pathname.startsWith('/pluginfile.php/')) throw new Error('文件不可用，收到的仍是课程页面。');
    const final = new URL(result.url);
    if (!final.pathname.startsWith('/pluginfile.php/')) throw new Error('资源没有返回学校文件地址。');
    const name = safeName(decodeURIComponent(final.pathname.split('/').pop()));
    const sha = crypto.createHash('sha256').update(result.buffer).digest('hex');
    const courseDir = path.join(this.downloads, courseId ? `course-${numericId(courseId)}` : 'unfiled');
    let index = {};
    try { index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('下载索引损坏，请备份后修复 downloads.json。'); }
    const twin = Object.values(index).find((x) => x.sha === sha && x.courseDir === courseDir && fs.existsSync(x.path));
    let file = twin?.path;
    if (!file) {
      fs.mkdirSync(courseDir, { recursive: true, mode: 0o700 });
      file = path.join(courseDir, name);
      if (fs.existsSync(file)) {
        const parsed = path.parse(name);
        file = path.join(courseDir, `${parsed.name}-${sha.slice(0, 10)}${parsed.ext}`);
      }
      fs.writeFileSync(file, result.buffer, { mode: 0o600 });
    }
    index[url.href] = { sha, path: file, courseDir, downloadedAt: new Date().toISOString() };
    secureJson(this.indexPath, index);
    return { name, path: file, size: result.buffer.length, contentType: result.contentType, duplicate: !!twin, sha256: sha, buffer: result.buffer };
  }

  async readFile(url, courseId, { offset = 0, max_chars = 20000 } = {}) {
    const { buffer, ...file } = await this.download(url, courseId);
    const body = await extractText(buffer, { name: file.name, contentType: file.contentType });
    return { ...file, text: body === null ? '此格式已保存，但暂不支持文本提取。' : !body.trim() ? '文件没有文本层（扫描件需要 OCR）。' : window(body, { offset, maxChars: max_chars }) };
  }

  async saveCourse(courseId, max = 150) {
    const course = await this.course(courseId);
    const resources = course.items.filter((x) => x.available && ['resource', 'folder', 'page'].includes(x.type));
    const urls = new Set(); const failed = []; const saved = [];
    for (const item of resources) {
      try {
        if (item.type === 'resource') urls.add(item.url);
        else for (const f of (await this.activity(item.id, item.type)).files) urls.add(f.url);
      } catch (e) { failed.push({ name: item.name, error: e.message }); }
    }
    for (const url of [...urls].slice(0, max)) {
      try { const { buffer, ...file } = await this.download(url, courseId); saved.push(file); }
      catch (e) { failed.push({ url, error: e.message }); }
    }
    return { course_id: String(courseId), found: urls.size, processed: saved.length + failed.length, truncated: urls.size > max, saved, failed,
      note: '扫描可见资源、文件夹和课程页面的文件链接；未递归追踪外部站点、论坛附件或受限内容。已存文件按内容去重，每次仍会请求服务器以确认内容。' };
  }
}

export function numericId(id) { const value = String(id); if (!/^\d+$/.test(value)) throw new Error('ID 必须是数字。'); return value; }
