// Tests the user's own school session through the real stdio MCP boundary.
// Prints counts and timings, never cookies, grades, or document contents.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'course-id': { type: 'string' }, 'resource-id': { type: 'string' } } });
const cli = fileURLToPath(new URL('../bin/xjtlu-cli.js', import.meta.url));
const client = new Client({ name: 'verify-xjtlu-live', version: '1' });
const results = [];
async function check(name, args = {}) {
  const start = Date.now();
  try {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(response.content[0].text);
    const value = JSON.parse(response.content[0].text);
    results.push({ tool: name, ok: true, ms: Date.now() - start });
    console.log(`✓ ${name} (${Date.now() - start} ms)`);
    return value;
  } catch (e) {
    results.push({ tool: name, ok: false, ms: Date.now() - start });
    console.error(`✗ ${name}: ${e.message}`); throw e;
  }
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'serve'], env: process.env, stderr: 'inherit' }));
  const { tools } = await client.listTools(); console.log(`MCP tools: ${tools.length}`);
  const identity = await check('moodle_whoami');
  const courseList = await check('moodle_list_courses');
  console.log(`Courses: ${courseList.courses.length}, complete: ${courseList.complete}`);
  const courseId = values['course-id'] || courseList.courses[0]?.id;
  if (!courseId) throw new Error('此账号没有可测试的课程。');
  const course = await check('moodle_get_course', { course_id: courseId });
  console.log(`Sections: ${course.sections.length}, activities: ${course.items.length}`);
  const assignments = await check('moodle_list_assignments', { course_id: courseId });
  console.log(`Assignments/quizzes: ${assignments.items.length}`);
  const activity = assignments.items.find((x) => x.available && ['quiz', 'assign'].includes(x.type));
  if (activity) { const value = await check('moodle_get_activity', { activity_id: activity.id, type: activity.type }); console.log(`Activity text characters: ${value.text?.length || 0}`); }
  await check('moodle_list_files', { course_id: courseId });
  const resource = values['resource-id'] ? { id: values['resource-id'] } : course.items.find((x) => x.available && x.type === 'resource');
  if (resource) {
    const result = await check('moodle_read_file', { url: `${identity.site}/mod/resource/view.php?id=${resource.id}`, course_id: courseId, max_chars: 1000 });
    const textOk = !!result.text && !/暂不支持|没有文本层/.test(result.text);
    console.log(`File bytes: ${result.size}, text extracted: ${textOk}`);
    if (!textOk) throw new Error('文件可以下载，但本次文件未验证文本提取。');
  }
} catch { process.exitCode = 1; }
finally { await client.close(); console.log(JSON.stringify({ passed: results.filter((x) => x.ok).length, total: results.length, results }, null, 2)); }
