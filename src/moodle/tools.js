import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

const id = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String);
const url = z.string().url();
const saveDir = z.string().min(1).max(500).optional().describe('保存到哪个文件夹：完整路径（绝对路径），必须在学生自己的用户目录里。不填则存到默认课件目录（文稿/XJTLU Core）。');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MOODLE_TOOLS = [
  { name: 'moodle_whoami', description: '检查西浦 Learning Mall / Moodle 的登录状态；登录窗口开着时返回登录进度。', input: {}, run: (c) => c.loginState() },
  { name: 'moodle_login', localWrite: true, description: '学生需要登录或登录已过期时调用：在学生电脑上弹出学校登录窗口（普通 Chrome / Edge）后立即返回。学生在窗口里自己输入账号密码，完成后窗口自动关闭；之后可用 moodle_whoami 确认。已登录时直接返回已登录。绝不要向学生索要密码。',
    input: {}, run: (c) => c.startLogin() },
  { name: 'moodle_list_courses', description: '列出自己的 Moodle 课程，包括归档课程。visible_only 只列出首页可见课程，结果会明确说明完整性。',
    input: { visible_only: z.boolean().optional() }, run: (c, a) => a.visible_only ? c.visibleCourses() : c.courses() },
  { name: 'moodle_get_course', description: '读取课程分区、周次及资料/作业链接。受限内容仅标记，不尝试访问。', input: { course_id: id }, run: (c, a) => c.course(a.course_id) },
  { name: 'moodle_upcoming_deadlines', description: '一次查出所有课程里 Moodle 登记了截止时间的作业、测验等（Moodle 首页时间线同款），时间换算为北京时间。只覆盖 Moodle 登记的活动；写在 handbook / 作业说明文件里的 DDL 要再用 moodle_find_deadlines 按课程查。',
    input: { days_ahead: z.number().int().min(1).max(180).optional() }, run: (c, a) => c.upcoming(a.days_ahead ?? 60) },
  { name: 'moodle_find_deadlines', description: '按课程查 DDL：汇总课程页上带日期的活动，并读取 Module Handbook、Coursework / Assessment Specification 等文件（只读不保存），摘出写着截止日期、周次、考试安排的句子并注明来源文件。',
    input: { course_id: id, max_documents: z.number().int().min(1).max(8).optional() }, run: (c, a) => c.findDeadlines(a.course_id, { maxDocuments: a.max_documents ?? 4 }) },
  { name: 'moodle_list_assignments', description: '列出课程页面中的作业和测验，保留学校显示的日期。进一步用 moodle_get_activity 阅读详情。',
    input: { course_id: id }, run: (c, a) => c.assignments(a.course_id) },
  { name: 'moodle_get_activity', description: '读取作业说明、测验开放/截止时间、已有完成情况，或论坛/课程页面/文件夹。不开始测验、不提交作业。',
    input: { activity_id: id, type: z.enum(['assign', 'quiz', 'forum', 'page', 'folder', 'resource', 'url']) }, run: (c, a) => c.activity(a.activity_id, a.type) },
  { name: 'moodle_list_files', description: '列出课程中的文件、文件夹和页面入口；文件夹内部文件用 moodle_get_activity 读取。', input: { course_id: id },
    async run(c, a) { const course = await c.course(a.course_id); return { course: course.name, items: course.items.filter((x) => ['resource', 'folder', 'page'].includes(x.type)) }; } },
  { name: 'moodle_read_file', localWrite: true, description: '下载学校站点中的课件到本地并返回 PDF / DOCX / HTML / 文本内容。可用 offset 分段读取。save_dir 可指定保存到哪个文件夹（如学生当前的工作文件夹），文件直接放在其中。',
    input: { url, course_id: id.optional(), offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(500).max(100000).optional(), save_dir: saveDir },
    run: (c, a) => c.readFile(a.url, a.course_id, { offset: a.offset, max_chars: a.max_chars, saveDir: a.save_dir }) },
  { name: 'moodle_save_course_files', localWrite: true, description: '将一门课的可见文件和文件夹内资料保存到本地；按内容去重，返回保存文件夹、失败项和扫描范围。save_dir 可指定保存位置（如学生当前的工作文件夹），会在其中建一个以课程名命名的子文件夹。调用前先和学生确认是哪门课、要整门课还是其中一部分、存到哪里。',
    input: { course_id: id, max: z.number().int().min(1).max(500).optional(), save_dir: saveDir }, run: (c, a) => c.saveCourse(a.course_id, a.max, { saveDir: a.save_dir }) },
  { name: 'moodle_export_course_html', localWrite: true, description: '导出本地课程目录 HTML，包含资料名称、说明、日期和学校原始链接；不包含登录凭据。',
    input: { course_id: id }, async run(c, a) {
      const course = await c.course(a.course_id);
      const directory = path.join(c.downloads, `course-${a.course_id}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(course.name)}</title><style>body{font:16px/1.7 system-ui;max-width:900px;margin:60px auto;padding:0 24px;background:#f6f5f1;color:#172e2b}a{color:#006659}section{background:white;padding:24px;margin:20px 0;border-radius:16px}small{color:#64716e}li{margin:12px 0}</style><h1>${esc(course.name)}</h1><p>课程目录快照 · ${new Date().toISOString().slice(0, 10)} · 资料链接需要学校登录</p>${course.sections.map((s) => `<section><h2>${esc(s.name)}</h2><ul>${s.items.map((it) => `<li>${it.url ? `<a href="${esc(it.url)}">${esc(it.name)}</a>` : esc(it.name) + '（受限）'} <small>${esc(it.type)}</small><p>${esc(it.dates)}</p></li>`).join('')}</ul></section>`).join('')}</html>`;
      const file = path.join(directory, 'index.html'); fs.writeFileSync(file, html, { mode: 0o600 });
      return { path: file, sections: course.sections.length, items: course.items.length, note: '目录快照；链接的课件正文没有内嵌。' };
    } },
];

export async function invokeTool(client, name, args = {}) {
  const tool = MOODLE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('未知工具。');
  return tool.run(client, z.object(tool.input).strict().parse(args));
}

export function registerMoodleTools(server, client) {
  for (const tool of MOODLE_TOOLS) server.registerTool(tool.name, {
    description: tool.description, inputSchema: tool.input,
    annotations: { readOnlyHint: !tool.localWrite, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await invokeTool(client, tool.name, args), null, 1) }] }; }
    catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
}
