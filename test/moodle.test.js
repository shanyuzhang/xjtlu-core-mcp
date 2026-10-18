import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MoodleClient, allowedUrl, deadlineLines, docScore } from '../src/moodle/client.js';
import { MoodleSession, loginResponseHint, signedInResponse } from '../src/moodle/session.js';
import { EventEmitter } from 'node:events';
import { parseCourse, parseIdentity, parsePage } from '../src/moodle/parse.js';
import { createWebServer } from '../src/moodle/web.js';
import { installTarget, upsertMoodleToml, targets } from '../src/moodle/setup.js';
import { invokeTool } from '../src/moodle/tools.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xjtlu-test-'));
const identity = '<button id="user-menu-toggle"><span class="usertext">Test Student</span></button>';
function textPdf() {
  const stream = 'BT /F1 18 Tf 50 740 Td (Moodle test lecture) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(data);
}
const fixture = `${identity}<h1>AI &amp; Maths</h1><main id="region-main"><ul><li id="section-1" data-sectionname="Week 1"><h3 class="sectionname">Week 1</h3><ul>
<li id="module-10" class="activity modtype_resource"><div data-activityname="Lecture"><a href="/mod/resource/view.php?id=10"><span class="instancename">Lecture <span>File</span></span></a></div></li>
<li id="module-11" class="activity modtype_folder"><a href="/mod/folder/view.php?id=11">Lab Folder</a></li>
<li id="module-12" class="activity modtype_quiz"><a href="/mod/quiz/view.php?id=12">CW1 Quiz</a><div class="activity-dates">Closed: 31 March 2026, 23:59</div></li>
<li id="module-13" class="activity modtype_quiz"><div class="activityname">Restricted Quiz</div><p>Group membership required</p></li></ul></li></ul></main>`;
// 当前学年站点的分页课程（grid 格式）：主页只内嵌第 0 节，其余各节在 /course/section.php?id=N。
const gridMain = `${identity}<h1>Grid Course</h1><main id="region-main"><ul><li id="section-0"><h3 class="sectionname">General</h3><ul>
<li id="module-50" class="activity modtype_forum"><a href="/mod/forum/view.php?id=50">Announcements</a></li></ul></li></ul>
<a class="grid-section-inner" href="/course/section.php?id=501">Week 1</a><a class="grid-section-inner" href="/course/section.php?id=502">Week 2</a></main>`;
const gridSection501 = `${identity}<h1>Grid Course</h1><main id="region-main"><ul><li id="section-1" data-sectionname="Week 1"><ul>
<li id="module-50" class="activity modtype_forum"><a href="/mod/forum/view.php?id=50">Announcements</a></li>
<li id="module-51" class="activity modtype_resource"><a href="/mod/resource/view.php?id=51">Week 1 slides</a></li></ul></li></ul></main>`;
const gridSection502 = `${identity}<h1>Grid Course</h1><main id="region-main"><ul><li id="section-2" data-sectionname="Week 2"><ul>
<li id="module-52" class="activity modtype_assign"><a href="/mod/assign/view.php?id=52">Coursework 1</a><div class="activity-dates">Due: Friday, 30 October 2026, 17:00</div></li></ul></li></ul></main>`;
let server; let base; const requests = [];
before(async () => {
  server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    const u = new URL(req.url, base);
    const send = (body, type = 'text/html') => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
    if (req.headers.cookie !== 'MoodleSession=good') { res.writeHead(302, { Location: '/login/index.php' }); res.end(); return; }
    if (u.pathname === '/my/') return send(`${identity}<h1>Dashboard</h1><a href="/course/view.php?id=1">AI &amp; Maths</a>`);
    if (u.pathname === '/my/courses.php') return send(`${identity}<script>M.cfg={"sesskey":"test-only-key"}</script>`);
    if (u.pathname === '/lib/ajax/service.php') {
      let data = ''; for await (const c of req) data += c;
      const payload = JSON.parse(data)[0];
      if (payload.methodname === 'core_calendar_get_action_events_by_timesort') {
        assert.ok(payload.args.timesortto > payload.args.timesortfrom);
        return send(JSON.stringify([{ error: false, data: { events: [{ id: 9, name: 'Coursework 1 is due', activityname: 'Coursework 1', modulename: 'assign', timesort: 1793350800, overdue: false,
          course: { id: 5, fullname: 'Grid Course' }, action: { name: 'Add submission' }, url: '/mod/assign/view.php?id=52' }] } }]), 'application/json');
      }
      assert.equal(payload.methodname, 'core_course_get_enrolled_courses_by_timeline_classification');
      assert.equal(payload.args.classification, 'all');
      const offset = payload.args.offset;
      return send(JSON.stringify([{ error: false, data: { courses: [{ id: offset ? 2 : 1, fullname: offset ? 'Finance' : 'AI & Maths' }], nextoffset: offset ? 0 : 100 } }]), 'application/json');
    }
    if (u.pathname === '/course/view.php' && u.searchParams.get('id') === '5') return send(gridMain);
    if (u.pathname === '/course/view.php' && u.searchParams.get('id') === '6') return send(`${identity}<h1>Stats</h1><main id="region-main"><ul><li id="section-1" data-sectionname="Week 1"><ul>
<li id="module-61" class="activity modtype_resource"><a href="/mod/resource/view.php?id=61">Module Handbook</a></li>
<li id="module-62" class="activity modtype_folder"><a href="/mod/folder/view.php?id=62">Coursework</a></li>
<li id="module-63" class="activity modtype_resource"><a href="/mod/resource/view.php?id=63">Lecture 1 slides</a></li></ul></li></ul></main>`);
    if (u.pathname === '/mod/resource/view.php' && u.searchParams.get('id') === '61') { res.writeHead(303, { Location: '/pluginfile.php/161/mod_resource/content/1/handbook.txt' }); res.end(); return; }
    if (u.pathname === '/mod/folder/view.php' && u.searchParams.get('id') === '62') return send('<main id="region-main"><a href="/pluginfile.php/162/mod_folder/content/0/CW2%20specification.txt">CW2 specification.txt</a><a href="/pluginfile.php/162/mod_folder/content/0/data.csv">data.csv</a></main>');
    if (u.pathname.endsWith('/handbook.txt')) return send('Assessment Details\nAssessment Task Weighting Release Date Due Date Coursework 2 15% 27/Nov/2026 11/Dec/2026 17:00\nWe meet in room 1/2.', 'text/plain');
    if (u.pathname.endsWith('/CW2%20specification.txt')) return send('Important Dates\nEvent Open date Due date\nReport\nsubmission\nDecember 7, 2026 (Monday) 0:00\nAM\nDecember 13, 2026 (Sunday) 23:59\nPM\nMarking components', 'text/plain');
    if (u.pathname === '/course/section.php' && u.searchParams.get('id') === '501') return send(gridSection501);
    if (u.pathname === '/course/section.php' && u.searchParams.get('id') === '502') return send(gridSection502);
    if (u.pathname === '/mod/assign/view.php' && u.searchParams.get('id') === '77') { res.writeHead(303, { Location: '/course/cms/77/restricted' }); res.end(); return; }
    if (u.pathname === '/course/view.php') return send(fixture);
    if (u.pathname === '/mod/resource/view.php' && u.searchParams.get('id') === '99') { res.writeHead(302, { Location: 'https://evil.example/steal' }); res.end(); return; }
    if (u.pathname === '/mod/resource/view.php' && u.searchParams.get('id') === '97') return send('<main id="region-main"><iframe src="/pluginfile.php/125/mod_resource/content/0/lecture.pdf?embed=1"></iframe><a href="/pluginfile.php/125/mod_resource/content/0/lecture.pdf">lecture.pdf</a></main>');
    if (u.pathname === '/mod/resource/view.php' && u.searchParams.get('id') === '98') return send('x'.repeat(100), 'application/octet-stream');
    if (u.pathname === '/mod/resource/view.php') { res.writeHead(303, { Location: '/pluginfile.php/123/mod_resource/content/1/notes.txt' }); res.end(); return; }
    if (u.pathname === '/mod/folder/view.php') return send('<h1>Lab folder</h1><main id="region-main"><a href="/pluginfile.php/124/mod_folder/content/0/notes-copy.txt?forcedownload=1">Notes</a></main>');
    if (u.pathname === '/mod/quiz/view.php') return send('<h1>CW1</h1><main id="region-main"><p>Closed: 31 March 2026, 23:59</p><p>Finished</p><button>Start attempt</button></main>');
    if (u.pathname.endsWith('/lecture.pdf')) return send(textPdf(), 'application/pdf');
    if (u.pathname.startsWith('/pluginfile.php/')) return send('Vectors and matrices. <script>not executed</script>', 'text/plain');
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
const session = { cookieHeader: () => 'MoodleSession=good' };
const make = () => new MoodleClient({ base, session, downloads: path.join(home, 'downloads'), dataDir: home });

test('Moodle parsing recovers real-theme section, activity types, restrictions and dates', () => {
  const result = parseCourse(fixture, base);
  assert.equal(result.name, 'AI & Maths'); assert.equal(result.sections[0].name, 'Week 1');
  assert.equal(result.items[0].name, 'Lecture'); assert.equal(result.items[2].type, 'quiz');
  assert.match(result.items[2].dates, /31 March/); assert.equal(result.items[3].available, false);
  assert.equal(parseIdentity(identity, base).connected, true); assert.equal(parseIdentity('<h1>Log in</h1>', base).connected, false);
});

test('embedded PDF and folder files are found; external file links are omitted', () => {
  const page = parsePage('<h1>PDF</h1><main id="region-main"><object data="/pluginfile.php/1/x.pdf"></object><a href="https://evil.example/pluginfile.php/a">bad</a></main>', base);
  assert.equal(page.files.length, 1); assert.match(page.files[0].url, /\/x.pdf$/);
});

test('URL and method restrictions block cross-origin, state changes and traversal', async () => {
  for (const u of ['https://evil.example/x', '/login/logout.php', '/mod/quiz/startattempt.php?id=1', '/my/?action=delete', '/course/../admin/index.php']) assert.throws(() => allowedUrl(u, base));
  await assert.rejects(make().request('/lib/ajax/service.php', { method: 'POST', data: [{ methodname: 'core_user_delete_users' }] }), /不允许/);
  await assert.rejects(make().request('/my/', { method: 'POST', data: [{ methodname: 'core_course_get_enrolled_courses_by_timeline_classification' }] }), /只允许/);
});

test('authenticated status and complete paginated course list work over the real HTTP client', async () => {
  assert.equal((await make().status()).name, 'Test Student');
  const result = await make().courses(); assert.equal(result.complete, true); assert.deepEqual(result.courses.map((c) => c.id), ['1', '2']);
});

test('visible-only courses explicitly report partial coverage', async () => {
  const result = await make().visibleCourses(); assert.equal(result.complete, false); assert.equal(result.courses[0].id, '1');
});

test('assignment details are read without starting attempts', async () => {
  const result = await make().assignments('1'); assert.equal(result.items.length, 2);
  const detail = await make().activity('12', 'quiz'); assert.match(detail.text, /31 March/);
  assert.ok(!requests.some((r) => r.url.includes('startattempt')));
});

test('resource redirect, text extraction, content deduplication and batch files', async () => {
  const client = make(); const first = await client.readFile(`${base}/mod/resource/view.php?id=10`, '1');
  assert.match(first.text, /Vectors and matrices/); assert.ok(fs.existsSync(first.path));
  const second = await client.readFile(`${base}/pluginfile.php/124/mod_folder/content/0/notes-copy.txt`, '1');
  assert.equal(second.duplicate, true); assert.equal(first.path, second.path);
  const saved = await client.saveCourse('1'); assert.equal(saved.failed.length, 0); assert.equal(saved.saved.length, 2);
});

test('embedded resource page downloads the plain file link instead of the ?embed one', async () => {
  const file = await make().readFile(`${base}/mod/resource/view.php?id=97`, '1');
  assert.equal(file.contentType, 'application/pdf'); assert.ok(fs.existsSync(file.path));
});

test('paginated (grid) courses merge every section page, without duplicates, so DDL and files appear', async () => {
  const course = await make().course('5');
  assert.deepEqual(course.items.map((it) => it.id), ['50', '51', '52']);
  assert.deepEqual(course.sections.map((sec) => sec.name), ['General', 'Week 1', 'Week 2']);
  const ddl = await make().assignments('5');
  assert.equal(ddl.items.length, 1); assert.match(ddl.items[0].dates, /30 October 2026/);
});

test('restricted activities report a clear message, and a dropped connection is retried', async () => {
  await assert.rejects(make().activity('77', 'assign'), (e) => e.code === 'RESTRICTED' && /受限/.test(e.message));
  const c = make(); const real = c.fetch; let calls = 0;
  c.fetch = async (...args) => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return real(...args); };
  assert.equal((await c.status()).connected, true); assert.equal(calls, 2);
  const down = make(); down.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(down.status(), /无法连接/);
});

test('re-running setup moves the old 25-26 archive default to the current-year site, but keeps a custom site', () => {
  const cli = fileURLToPath(new URL('../bin/xjtlu-cli.js', import.meta.url));
  const run = (saved, extra = []) => {
    const dir = fs.mkdtempSync(path.join(home, 'setup-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ base: saved }));
    const env = { ...process.env, XJTLU_MCP_HOME: dir, XJTLU_MCP_DOWNLOADS: path.join(dir, 'files') }; delete env.XJTLU_URL;
    const r = spawnSync(process.execPath, [cli, 'setup', '--no-install', '--no-login', '--yes', '--clients', 'none', ...extra], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).base;
  };
  assert.equal(run('https://core-archive25-26.xjtlu.edu.cn'), 'https://core.xjtlu.edu.cn');
  assert.equal(run('https://moodle.example.edu'), 'https://moodle.example.edu');
  assert.equal(run('https://core.xjtlu.edu.cn', ['--url', 'https://core-archive25-26.xjtlu.edu.cn']), 'https://core-archive25-26.xjtlu.edu.cn');
});

test('upcoming deadlines come from the Moodle timeline in Beijing time', async () => {
  const r = await make().upcoming(30);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].name, 'Coursework 1'); assert.equal(r.items[0].action, 'Add submission');
  assert.match(r.items[0].due, /2026\/10\/30.*17:00/); assert.match(r.note, /moodle_find_deadlines/);
});

test('course deadline search reads handbook and specification files without saving them', async () => {
  const before = fs.existsSync(path.join(home, 'downloads', 'course-6'));
  const r = await make().findDeadlines('6');
  assert.equal(before, false); assert.equal(fs.existsSync(path.join(home, 'downloads', 'course-6')), false);
  assert.deepEqual(r.documents.map((d) => d.name).sort(), ['CW2 specification.txt', 'Module Handbook']);
  assert.ok(!r.documents.some((d) => /Lecture|data\.csv/.test(d.name)));
  const all = r.documents.flatMap((d) => d.snippets).join('\n');
  assert.match(all, /11\/Dec\/2026 17:00/); assert.match(all, /December 13, 2026 \(Sunday\) 23:59/); assert.doesNotMatch(all, /room 1\/2/);
});

test('deadline extraction handles flattened PDF tables, long table rows and ignores date-free noise', () => {
  const table = deadlineLines('Important Dates\nEvent Open date Due date\nReport\nsubmission\nDecember 7, 2026 (Monday) 0:00\nAM\nDecember 13, 2026 (Sunday) 23:59\nPM\nMarking components');
  assert.equal(table.length, 1); assert.match(table[0], /^Important Dates .*December 13, 2026 \(Sunday\) 23:59 \/ PM$/);
  const long = deadlineLines(`${'Intro text. '.repeat(40)}Assessment Task Due Date Coursework 1 15% 16/Oct/2026 30/Oct/2026 17:00 ${'AI rules apply. '.repeat(30)}`);
  assert.equal(long.length, 1); assert.match(long[0], /30\/Oct\/2026 17:00/); assert.ok(long[0].length <= 262);
  assert.deepEqual(deadlineLines('Chapter 3 covers 1/2 of it.\nWe met on 3 March.\nThe exam is important.'), []);
  assert.match(deadlineLines('Class test 2: Wednesday night, Week 13')[0], /Week 13/);
  assert.ok(docScore('MTH205 Module Handbook') > 0 && docScore('Coursework 1 brief') > docScore('Group Coursework')); assert.equal(docScore('Lecture 3 slides'), 0);
  assert.deepEqual(deadlineLines('Due Date\nWe meet in room 1/2.\nweek 3 recap'), []);
});

test('same-name different content is not overwritten', async () => {
  const c = make(); c.fetch = async () => new Response('A different lecture', { headers: { 'Content-Type': 'text/plain' } });
  const prior = await make().readFile(`${base}/pluginfile.php/2/notes.txt`, '1');
  const next = await c.readFile(`${base}/pluginfile.php/3/notes.txt`, '1');
  assert.notEqual(prior.path, next.path); assert.match(fs.readFileSync(prior.path, 'utf8'), /Vectors/);
});

test('a real PDF response downloads and yields its page text', async () => {
  const file = await make().readFile(`${base}/pluginfile.php/125/lecture.pdf`, '1');
  assert.match(file.text, /--- page 1 ---/); assert.match(file.text, /Moodle test lecture/);
  assert.ok(fs.readFileSync(file.path).subarray(0, 8).toString().startsWith('%PDF-1.4'));
});

test('oversized streamed responses are cancelled and auth redirect never leaks cookies', async () => {
  const c = make(); c.fetch = async () => new Response('x', { headers: { 'Content-Length': String(250 * 1024 * 1024) } });
  await assert.rejects(c.request('/my/'), /200 MB/);
  const seen = []; const external = make(); external.fetch = async (u) => { seen.push(new URL(u).origin); return new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }); };
  await assert.rejects(external.request('/my/'), /校外/); assert.deepEqual(seen, [base]);
  await assert.rejects(new MoodleClient({ base, session: { cookieHeader: () => '' } }).status(), /登录/);
});

test('cookie domain/path/expiry filtering and secure state storage', () => {
  const stateFile = path.join(home, 'cookie-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ cookies: [
    { name: 'MoodleSession', value: 'good', domain: 'core.example.edu', path: '/', expires: -1, secure: true },
    { name: 'SSO', value: 'private', domain: 'sso.example.edu', path: '/', expires: -1, secure: true },
    { name: 'admin', value: 'path', domain: 'core.example.edu', path: '/admin', expires: -1, secure: true },
    { name: 'old', value: 'expired', domain: '.example.edu', path: '/', expires: 1, secure: true },
  ] }));
  const manager = new MoodleSession('https://core.example.edu', { stateFile });
  assert.equal(manager.cookieHeader('https://core.example.edu/my/'), 'MoodleSession=good');
  assert.equal(manager.cookieHeader('http://core.example.edu/my/'), '');
  manager.updateCookies(new Response('', { headers: { 'Set-Cookie': 'MoodleSession=new; Path=/; Secure; HttpOnly' } }), 'https://core.example.edu/my/');
  assert.equal(manager.cookieHeader('https://core.example.edu/my/'), 'MoodleSession=new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test('login reports its stage, saves only the dedicated session, and closes its browser', async () => {
  const stateFile = path.join(home, 'dedicated-session.json'); let closed = false;
  let url = 'about:blank'; const stages = [];
  const page = {
    goto: async () => { url = `${base}/my/`; }, url: () => url, isClosed: () => false,
    bringToFront: async () => {}, locator: () => ({ count: async () => 1 }),
  };
  const manager = new MoodleSession(base, { stateFile, profileDir: path.join(home, 'dedicated-profile'), launchBrowser: async () => ({
    pages: () => [page], storageState: async () => ({ cookies: [{ name: 'MoodleSession', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1 }], origins: [{ origin: base }] }), close: async () => { closed = true; },
  }) });
  await manager.login({ headless: true, onProgress: (message) => stages.push(message) });
  assert.equal(closed, true); assert.equal(manager.pending, null);
  assert.match(stages[0], /启动/); assert.match(stages.at(-1), /会话已保存/);
  const saved = JSON.parse(fs.readFileSync(stateFile)); assert.equal(saved.cookies.length, 1); assert.deepEqual(saved.origins, []);
});

test('browser startup timeout is distinguished from a school network failure', async () => {
  const manager = new MoodleSession(base, { profileDir: path.join(home, 'failed-profile'), launchBrowser: async () => {
    const error = new Error('fixture timeout'); error.name = 'TimeoutError'; throw error;
  } });
  await assert.rejects(manager.login({ headless: true }), /浏览器启动超时/);
  assert.equal(manager.loginStatus, '登录未完成'); assert.equal(manager.pending, null);
});

test('visible login uses an uncontrolled browser, waits for Moodle in its net log, then saves the session', async () => {
  const stateFile = path.join(home, 'manual-session.json'); const profileDir = path.join(home, 'manual-profile');
  const netlog = path.join(profileDir, 'login-netlog.json'); let args; let signal; let launched; const stages = [];
  const event = (type, id, params) => `${JSON.stringify({ type, source: { id }, params })},\n`;
  const proc = new EventEmitter(); proc.exitCode = null; proc.signalCode = null;
  proc.kill = (s) => { signal = s; proc.exitCode = 0; setImmediate(() => proc.emit('exit', 0)); };
  const manager = new MoodleSession(base, { stateFile, profileDir, pollMs: 5, findBrowser: (c) => (c === 'chrome' ? '/fake/chrome' : null),
    spawnBrowser: (exe, a) => {
      args = a;
      fs.writeFileSync(netlog, `{"constants":{"logEventTypes":{"URL_REQUEST_START_JOB":1,"HTTP_TRANSACTION_READ_RESPONSE_HEADERS":2}},\n"events": [\n`);
      setTimeout(() => fs.appendFileSync(netlog, event(1, 7, { url: `${base}/my/` }) + event(2, 7, { headers: ['HTTP/1.1 303'] })
        + event(1, 8, { url: 'https://uim.xjtlu.edu.cn/login/html-design-builtIn/accountPsw.js' }) + event(2, 8, { headers: ['HTTP/1.1 200'] })), 10);
      setTimeout(() => fs.appendFileSync(netlog, event(1, 9, { url: `${base}/my/` }) + event(2, 9, { headers: ['HTTP/1.1 200'] })), 30);
      return proc;
    },
    launchBrowser: async (dir, options) => { launched = options; return {
      pages: () => [{ goto: async () => {}, locator: () => ({ count: async () => 1 }) }],
      storageState: async () => ({ cookies: [{ name: 'MoodleSession', value: 'fixture', domain: '127.0.0.1', path: '/', expires: -1 }], origins: [] }), close: async () => {},
    }; } });
  await manager.login({ onProgress: (message) => stages.push(message) });
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')));
  assert.ok(!args.some((a) => /remote-debugging|enable-automation/.test(a)));
  if (process.platform !== 'win32') assert.equal(signal, 'SIGINT');
  assert.equal(launched.headless, true); assert.equal(fs.existsSync(netlog), false);
  assert.ok(stages.some((m) => /认证表单已显示/.test(m))); assert.match(stages.at(-1), /会话已保存/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).cookies.length, 1);
});

test('net log watcher only reports 200 Moodle pages as signed in', () => {
  const site = new URL('https://core.example.edu');
  assert.equal(signedInResponse({ url: new URL('/my/', site), status: 200 }, site.origin), true);
  assert.equal(signedInResponse({ url: new URL('/my/', site), status: 303 }, site.origin), false);
  assert.equal(signedInResponse({ url: new URL('/local/login/index.php', site), status: 200 }, site.origin), false);
  assert.equal(signedInResponse({ url: new URL('https://evil.example/my/'), status: 200 }, site.origin), false);
});

test('oversized cookie response is classified without exposing the error response body', () => {
  assert.match(loginResponseHint(400, '<h1>400 Request Header Or Cookie Too Large</h1>'), /Cookie 过大/);
  assert.equal(loginResponseHint(400, 'private server details'), 'HTTP 400');
});

test('HTML export escapes course content and omits session keys', async () => {
  const output = await invokeTool(make(), 'moodle_export_course_html', { course_id: '1' });
  const html = fs.readFileSync(output.path, 'utf8'); assert.match(html, /AI &amp; Maths/); assert.doesNotMatch(html, /test-only-key|MoodleSession/);
});

test('MCP config merges preserve existing servers and create recoverable backups', () => {
  const file = path.join(home, 'mcp.json'); fs.writeFileSync(file, '{"mcpServers":{"other":{"command":"x"}}}');
  const result = installTarget({ file, format: 'json' }, { command: 'node', args: ['server.js', 'serve'] });
  assert.ok(fs.existsSync(result.backup)); assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers.other.command, 'x');
  const config = upsertMoodleToml('[mcp_servers.other]\ncommand="ok"\n[mcp_servers.xjtlu-core]\ncommand="old"\n', { command: 'C:\\Program Files\\node.exe', args: ['x.js'] });
  assert.match(config, /mcp_servers.other/); assert.equal((config.match(/\[mcp_servers.xjtlu-core\]/g) || []).length, 1);
});

test('local HTML API blocks foreign origins/Host and requires custom header for mutation', async () => {
  const web = createWebServer(make()); await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${web.address().port}`;
  try {
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/api/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      http.get(origin, { headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(`${origin}/api/login`, { method: 'POST' })).status, 404);
    const response = await fetch(`${origin}/api/tool`, { method: 'POST', headers: { 'X-XJTLU-Local': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'moodle_list_courses' }) });
    assert.equal((await response.json()).result.courses.length, 2);
  } finally { await new Promise((r) => web.close(r)); }
});

test('real stdio MCP advertises tools and reports missing login without starting browser', async () => {
  const cli = fileURLToPath(new URL('../bin/xjtlu-cli.js', import.meta.url));
  const mcp = new Client({ name: 'xjtlu-test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve'], env: { ...process.env, XJTLU_MCP_HOME: path.join(home, 'empty'), XJTLU_URL: 'https://core-archive25-26.xjtlu.edu.cn' } }));
  try {
    const { tools } = await mcp.listTools(); assert.equal(tools.length, 11);
    assert.match(mcp.getInstructions(), /先问清需求/); assert.match(mcp.getInstructions(), /moodle_find_deadlines/); assert.match(mcp.getInstructions(), /不要生成 Excel/);
    assert.equal(mcp.getServerVersion().version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.equal(tools.find((t) => t.name === 'moodle_get_course').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'moodle_save_course_files').annotations.readOnlyHint, false);
    const result = await mcp.callTool({ name: 'moodle_whoami', arguments: {} }); assert.equal(result.isError, true); assert.match(result.content[0].text, /登录/);
  } finally { await mcp.close(); }
});

test('one-line installer scripts are well-formed and keep the npm/Node fallbacks', () => {
  const sh = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'bootstrap', 'install.sh');
  if (process.platform !== 'win32') assert.equal(spawnSync('bash', ['-n', sh]).status, 0);
  const text = fs.readFileSync(sh, 'utf8');
  assert.match(text, /--quick/); assert.match(text, /SHASUMS256/); assert.match(text, /registry\.npmmirror\.com/);
  const ps1 = fs.readFileSync(sh.replace(/install\.sh$/, 'install.ps1'), 'utf8');
  assert.match(ps1, /--quick/); assert.match(ps1, /Get-FileHash/); assert.doesNotMatch(ps1, /^\s*exit\b/m); assert.match(text, /registry\.npmmirror\.com/); assert.match(ps1, /xjtlu-core-mcp/);
});

test('Kimi Code and Claude Code are detected and connected', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'xjtlu-clients-'));
  const launch = { command: '/x/node', args: ['/x/xjtlu-cli.js', 'serve'] };
  // 旧版 kimi-cli（只有 ~/.kimi）写到 ~/.kimi/mcp.json；有 ~/.kimi-code 时优先新版位置。
  fs.mkdirSync(path.join(fake, '.kimi'));
  let kimi = targets(fake, 'darwin', { env: {}, onPath: () => false }).find((t) => t.id === 'kimi-code');
  assert.equal(kimi.file, path.join(fake, '.kimi', 'mcp.json'));
  fs.mkdirSync(path.join(fake, '.kimi-code'));
  kimi = targets(fake, 'darwin', { env: {}, onPath: () => false }).find((t) => t.id === 'kimi-code');
  assert.equal(kimi.file, path.join(fake, '.kimi-code', 'mcp.json'));
  installTarget(kimi, launch);
  assert.deepEqual(JSON.parse(fs.readFileSync(kimi.file, 'utf8')).mcpServers['xjtlu-core'], launch);
  assert.equal(targets(fake, 'darwin', { env: {}, onPath: () => false }).some((t) => t.id === 'claude-code'), false);

  if (process.platform === 'win32') return;
  const bin = path.join(fake, 'bin'); fs.mkdirSync(bin);
  const log = path.join(fake, 'claude.log');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`;
  try {
    const claude = targets(fake, 'darwin', { env: {} }).find((t) => t.id === 'claude-code');
    assert.ok(claude); installTarget(claude, launch);
  } finally { process.env.PATH = saved; }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.at(-1), 'mcp add --scope user xjtlu-core -- /x/node /x/xjtlu-cli.js serve');
  assert.ok(calls.includes('mcp remove --scope user xjtlu-core'));
});
