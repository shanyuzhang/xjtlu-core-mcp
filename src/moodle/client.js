import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, secureJson, settings } from './config.js';
import { MoodleSession, LoginRequired, RestrictedActivity } from './session.js';
import { parseIdentity, parseCourses, parseCourse, parsePage, sessionKey, safeName } from './parse.js';
import { extractText, window } from '../text.js';

export const READ_METHODS = new Set(['core_course_get_enrolled_courses_by_timeline_classification', 'core_calendar_get_action_events_by_timesort']);
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

const BEIJING = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const beijing = (ts) => (ts ? BEIJING.format(new Date(ts * 1000)) : null);

// 文件名越像课程说明 / 作业说明，越可能写着 DDL。
const DOC_WORDS = [[/handbook|hand book|module guide|syllabus|outline|手册|大纲/i, 3], [/specification|\bspec\b|brief|requirement|instruction|说明/i, 3],
  [/assessment|coursework|assignment|project|report|essay|presentation|考核|作业|评估/i, 2], [/schedule|timetable|calendar|deadline|important date|week plan|安排|日程|截止/i, 2]];
export function docScore(name) { return DOC_WORDS.reduce((sum, [re, w]) => sum + (re.test(name || '') ? w : 0), 0); }

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?[\\s/-]+${MONTH}|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\bweek\\s*\\d{1,2}\\b|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]|第\\s*\\d{1,2}\\s*周`, 'i');
const DATES = new RegExp(DATE.source, 'gi');
// 写明了月份或年份的日期；只有这种日期才往上找表头拼接，避免把「room 1/2」「week 3」之类误当 DDL。
const STRONG = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?[\\s/-]+${MONTH}|\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]`, 'i');
const DEADLINE = /due|deadline|submi|hand[- ]?in|important dates?|key dates?|coursework|assignment|assessment|project|report|essay|presentation|quiz|\btest\b|exam|mid-?term|final|\blab\b|截止|提交|考试|测验|作业|报告|展示|重要日期/i;
const TINY = /^(?:am|pm|a\.m\.|p\.m\.|\(?[a-z]{3,9}day\)?|\d{1,2}[:.]\d{2}(?:\s*[ap]m)?)$/i;
const clip = (t) => (t.length > 260 ? `${t.slice(0, 257)}…` : t);

// 从课程文件里摘出「日期 / 周次 + 作业、考试等字样」的句子。PDF 表格常被拆成很多短行，
// 日期行本身不带关键词，所以往上看几行找表头（Important Dates、Due date…），并把后面紧跟的日期、AM/PM 一起拼进来。
export function deadlineLines(text, max = 25) {
  const lines = String(text).split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = []; const seen = new Set();
  const push = (t) => { const v = clip(t); if (!seen.has(v)) { seen.add(v); out.push(v); } return out.length >= max; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DATE.test(line)) continue;
    if (line.length > 300) {
      // 长段落 / 表格行：每处日期取前后一段，相距很近的合并为一条。
      let last = -1e9;
      for (const m of line.matchAll(DATES)) {
        if (m.index - last < 200) continue;
        last = m.index;
        const win = line.slice(Math.max(0, m.index - 140), m.index + 160);
        if (DEADLINE.test(win) && push((m.index > 140 ? '…' : '') + win)) return out;
      }
      continue;
    }
    if (DEADLINE.test(line)) { if (push(line)) return out; continue; }
    if (!STRONG.test(line)) continue;
    let from = -1;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) if (DEADLINE.test(lines[j]) && lines[j].length <= 120) from = j;
    if (from < 0) continue;
    let to = i;
    while (to + 1 < lines.length && to - i < 4 && (DATE.test(lines[to + 1]) || TINY.test(lines[to + 1]))) to++;
    if (push(lines.slice(from, to + 1).join(' / '))) return out;
    i = to;
  }
  return out;
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

  // Moodle 首页「时间线」同款接口：一次取得所有课程里登记过截止时间的作业、测验等。
  async upcoming(days = 60) {
    const key = sessionKey(await this.html('/my/courses.php'));
    if (!key) throw new Error('无法读取学校会话密钥，请重新登录。');
    const now = Math.floor(Date.now() / 1000);
    const events = []; let after = 0; let complete = false;
    for (let page = 0; page < 5; page++) {
      const args = { timesortfrom: now - 7 * 86400, timesortto: now + days * 86400, limitnum: 50, ...(after ? { aftereventid: after } : {}) };
      const r = await this.request(`/lib/ajax/service.php?sesskey=${encodeURIComponent(key)}&info=core_calendar_get_action_events_by_timesort`, {
        method: 'POST', data: [{ index: 0, methodname: 'core_calendar_get_action_events_by_timesort', args }],
      });
      let payload; try { payload = JSON.parse(r.buffer.toString('utf8')); } catch { throw new Error('时间线接口未返回有效 JSON。'); }
      if (!Array.isArray(payload) || payload[0]?.error) throw new Error('学校未开放时间线接口，请改用 moodle_find_deadlines 逐门课程查找。');
      const batch = payload[0].data?.events || [];
      events.push(...batch);
      if (batch.length < 50) { complete = true; break; }
      after = batch.at(-1).id;
    }
    return {
      window: `过去 7 天到未来 ${days} 天`, complete, timezone: '北京时间',
      items: events.map((e) => ({ course: e.course?.fullname || e.course?.shortname || '', course_id: e.course?.id ? String(e.course.id) : null,
        name: e.activityname || e.name, event: e.name, type: e.modulename, due: beijing(e.timesort), overdue: !!e.overdue,
        action: e.action?.name || null, url: e.url || e.action?.url || null })),
      note: '这里只有 Moodle 登记了截止时间的活动。很多课程只把 DDL 写在 Module Handbook、Coursework Specification 等文件里，请再用 moodle_find_deadlines 按课程查找。',
    };
  }

  // 按课程找 DDL：课程页上带日期的活动 + handbook / specification 等文件里写着截止日期的句子。
  async findDeadlines(courseId, { maxDocuments = 4 } = {}) {
    const course = await this.course(courseId);
    const activities = course.items.filter((it) => it.dates).map(({ name, type, section, dates, url }) => ({ name, type, section, dates, url }));
    const candidates = []; const seenUrl = new Set();
    const consider = (name, entry) => { const score = docScore(name); if (score > 0 && !seenUrl.has(entry.url || entry.page)) { seenUrl.add(entry.url || entry.page); candidates.push({ name, score, ...entry }); } };
    for (const it of course.items.filter((x) => x.available)) {
      if (it.type === 'resource') consider(it.name, { url: it.url });
      else if (it.type === 'page') consider(it.name, { page: it.id });
    }
    for (const folder of course.items.filter((x) => x.available && x.type === 'folder').slice(0, 15)) {
      try { for (const f of (await this.activity(folder.id, 'folder')).files) consider(f.name, { url: f.url, folder: folder.name }); } catch { /* 文件夹读取失败不影响其他 */ }
    }
    candidates.sort((a, b) => b.score - a.score);
    const documents = []; const failed = [];
    for (const doc of candidates.slice(0, maxDocuments)) {
      try {
        let text;
        if (doc.page) text = (await this.activity(doc.page, 'page')).text;
        else { const { result, name } = await this.fetchFile(doc.url); text = await extractText(result.buffer, { name, contentType: result.contentType }); }
        if (text === null) { failed.push({ name: doc.name, error: '此格式暂不支持提取文字。' }); continue; }
        if (!text.trim()) { failed.push({ name: doc.name, error: '文件没有文本层（扫描件）。' }); continue; }
        documents.push({ name: doc.name, ...(doc.folder ? { folder: doc.folder } : {}), url: doc.url || null, snippets: deadlineLines(text) });
      } catch (e) { failed.push({ name: doc.name, error: e.message }); }
    }
    return {
      course_id: String(courseId), course: course.name, activities_with_dates: activities, documents,
      not_read: candidates.slice(maxDocuments).map((d) => d.name), failed,
      note: '摘录只包含同时出现日期 / 周次和作业、考试等字样的句子，可能不完整；以学校文件原文为准。只写「第 N 周」的需要对照教学周历换算日期。需要细看时用 moodle_read_file 阅读全文。',
    };
  }

  async download(url, courseId) {
    const run = () => this.downloadFile(url, courseId);
    const task = this.downloadQueue.then(run, run);
    this.downloadQueue = task.catch(() => {});
    return task;
  }

  // 找到资源背后的真实文件并读取内容，不存盘（找 DDL 时只读 handbook 等文件）。
  async fetchFile(value) {
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
    return { url, result, name };
  }

  async downloadFile(value, courseId) {
    const { url, result, name } = await this.fetchFile(value);
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
