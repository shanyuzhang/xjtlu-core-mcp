const $ = (id) => document.getElementById(id);
let courses = []; let courseId; let currentItems = []; let poll;
const notice = (text) => { $('notice').textContent = text; };
async function api(path, data) {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XJTLU-Local': '1' }, body: JSON.stringify(data) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败。'); return value;
}
const tool = async (name, args = {}) => (await api('/api/tool', { name, args })).result;
async function busy(button, fn) {
  button.disabled = true; notice('正在读取，请稍候…');
  try { await fn(); } catch (e) { notice(e.message); } finally { button.disabled = false; }
}
async function status() {
  const state = await api('/api/status');
  $('status').textContent = state.connected ? '已连接' : state.loginPending ? '等待学校登录' : '未连接';
  $('status').classList.toggle('online', state.connected);
  $('site').textContent = new URL(state.site).hostname;
  $('connection-note').textContent = state.connected ? `已登录${state.name ? ` · ${state.name}` : ''}` : state.loginPending ? state.loginStatus || '正在打开 MCP 专用窗口…' : state.loginError || state.error || '点击连接，在学校页面完成登录。';
  $('downloads').textContent = `课件目录：${state.downloads}`;
  $('mcp').textContent = JSON.stringify(state.mcp, null, 2);
  $('login').disabled = state.loginPending;
  if (state.connected && poll) { clearInterval(poll); poll = undefined; notice('学校账号已连接，可以读取课程。'); }
}
function renderCourses() {
  const query = $('search').value.trim().toLowerCase(); $('courses').replaceChildren();
  for (const c of courses.filter((x) => x.name.toLowerCase().includes(query))) {
    const button = document.createElement('button'); button.className = 'course' + (String(c.id) === courseId ? ' selected' : '');
    const small = document.createElement('small'); small.textContent = `COURSE ${c.id}`;
    const strong = document.createElement('strong'); strong.textContent = c.name;
    const span = document.createElement('span'); span.textContent = '查看课程资料 ↗'; button.append(small, strong, span);
    button.addEventListener('click', () => busy(button, async () => {
      const detail = await tool('moodle_get_course', { course_id: c.id }); courseId = String(c.id); currentItems = detail.items;
      $('course-name').textContent = detail.name; $('detail').hidden = false; renderCourses(); renderItems(currentItems); notice(`已读取 ${detail.sections.length} 个分区、${detail.items.length} 个活动。`);
      $('detail').scrollIntoView({ behavior: 'smooth' });
    })); $('courses').append(button);
  }
  if (!$('courses').children.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '没有匹配的课程。'; $('courses').append(p); }
}
function showResult(value) { $('result-section').hidden = false; $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); $('result-section').scrollIntoView({ behavior: 'smooth' }); }
function renderItems(items) {
  $('items').replaceChildren();
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'item';
    const body = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = it.name;
    const p = document.createElement('p'); p.textContent = `${it.section} · ${it.type}${it.dates ? `\n${it.dates}` : ''}`; body.append(strong, p); row.append(body);
    const action = document.createElement('button'); action.className = 'secondary'; action.textContent = it.available ? it.type === 'resource' ? '保存并阅读' : '读取详情' : '受限';
    action.disabled = !it.available || !['resource', 'folder', 'page', 'assign', 'quiz', 'forum', 'url'].includes(it.type);
    action.addEventListener('click', () => busy(action, async () => {
      const result = it.type === 'resource' ? await tool('moodle_read_file', { url: it.url, course_id: courseId }) : await tool('moodle_get_activity', { activity_id: it.id, type: it.type });
      showResult(result); notice(it.type === 'resource' ? '课件已保存。' : '已读取详情。');
    })); row.append(action); $('items').append(row);
  }
  if (!items.length) $('items').textContent = '课程页面中没有找到匹配的活动。';
}
$('login').addEventListener('click', () => busy($('login'), async () => { const result = await api('/api/login', {}); notice(result.message); poll ||= setInterval(() => status().catch((e) => notice(e.message)), 4000); await status(); }));
$('refresh').addEventListener('click', () => busy($('refresh'), async () => { await status(); notice('状态已更新。'); }));
$('load-courses').addEventListener('click', () => busy($('load-courses'), async () => {
  let result;
  try { result = await tool('moodle_list_courses'); }
  catch (e) { notice(`${e.message}\n尝试读取首页可见课程…`); result = await tool('moodle_list_courses', { visible_only: true }); }
  courses = result.courses; renderCourses(); notice(result.complete ? `已读取 ${courses.length} 门课程。` : result.note);
}));
$('search').addEventListener('input', renderCourses);
$('assignments').addEventListener('click', () => { renderItems(currentItems.filter((x) => ['quiz', 'assign', 'turnitintooltwo'].includes(x.type))); notice('已筛选作业 / 测验；点击课程卡片可恢复全部资料。'); });
$('save-course').addEventListener('click', () => busy($('save-course'), async () => { showResult(await tool('moodle_save_course_files', { course_id: courseId })); notice('保存任务已完成，请查看失败项和保存目录。'); }));
status().catch((e) => notice(e.message));
