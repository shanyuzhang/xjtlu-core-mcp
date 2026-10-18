import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MoodleClient } from './client.js';
import { registerMoodleTools } from './tools.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// AI 客户端连接时读到的使用说明：先问清需求，DDL 要连文件一起查，结果直接在对话里给。
export const INSTRUCTIONS = `你在帮西交利物浦大学（XJTLU）的学生使用 Learning Mall（Moodle）课程助手，工具只读，不会提交作业、开始测验或发帖。

1. 先问清需求。学生说得笼统（例如刚装好、只说“帮我看看课程”），先用一句话问他要做什么：查 DDL / 截止日期、下载课件、阅读或总结某份讲义，还是别的。不要一上来就批量下载。

2. 查 DDL：先调用 moodle_upcoming_deadlines，拿到 Moodle 里登记的截止事件；再对相关课程（通常是学生本学期的正式课程，可先用 moodle_list_courses 列出）逐门调用 moodle_find_deadlines。很多 DDL 只写在 Module Handbook、Coursework / Assessment Specification 等 PDF 或网页里，不在 Moodle 日历中。合并去重后按时间排序，每条注明课程、事项、截止时间（北京时间）和来源（Moodle 或具体文件名）。不同来源时间不一致的要标出来，提醒学生以老师最新通知为准；文件里只写“第 N 周”的，说明需要对照教学周历。

3. 下载课件：先确认是哪门课（不确定就列出课程让学生选），要整门课还是某几周、某几份，以及存到哪里。如果你正在学生打开的某个工作文件夹里，默认用 save_dir 存到这个文件夹（整门课会在里面建一个以课程名命名的子文件夹），并先告诉学生一声；学生想换地方就按他说的路径存。不传 save_dir 时会存到「文稿/XJTLU Core」。整门课用 moodle_save_course_files，单份用 moodle_read_file。完成后告诉学生文件夹的完整路径，以及成功、失败的数量和原因。

4. 输出：结果直接在对话里用简洁的列表或表格给出，不要生成 Excel 或其他文件。最后可以顺带问一句是否需要整理成 HTML 页面，学生同意后再做。

5. 遇到“需要登录”的错误，请学生重新运行一次 https://shanyuzhang.com/xjtlu-core-mcp/ 上的安装命令，在弹出的窗口登录后再试。遇到“受限”的活动，说明那是学校设置的访问条件，不要尝试绕过。`;

export async function startMoodleServer() {
  const server = new McpServer({ name: 'xjtlu-session-mcp', version }, { instructions: INSTRUCTIONS });
  registerMoodleTools(server, new MoodleClient());
  await server.connect(new StdioServerTransport());
  return server;
}
