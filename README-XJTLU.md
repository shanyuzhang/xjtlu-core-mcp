# 西浦 Learning Mall Core MCP

适配西浦 Moodle，默认访问 AY25/26 归档站 `https://core-archive25-26.xjtlu.edu.cn`。与原 Canvas MCP 共存，客户端配置名称为 `xjtlu-core`。这是独立的非官方适配，保留原项目 MIT 许可及作者信息。

## 发给其他学生

把学生指南链接 <https://shanyuzhang.com/xjtlu-core-mcp/> 发给同学。学生只需打开终端粘贴一行：

```bash
/bin/bash -c "$(curl -fsSL https://shanyuzhang.com/xjtlu-core-mcp/install.sh)"
```

Windows 在 PowerShell 中运行 `irm https://shanyuzhang.com/xjtlu-core-mcp/install.ps1 | iex`。

一行安装脚本（源码在 `scripts/bootstrap/`）会：没有 Node.js 20+ 时下载官方 Node.js v24.21.0 到 `~/.xjtlu-session-mcp/node`（先试 nodejs.org，慢或失败时换 npmmirror，均按 SHA256SUMS 校验，不需要管理员权限）；检查 Chrome / Edge；从 GitHub Pages 下载工具包（失败时改用 GitHub 仓库 ZIP）；npm 官方源连不上时改用 npmmirror；然后运行 `setup --quick`（沿用默认学校地址和课件目录，只询问是否连接检测到的 AI 应用，回车即同意）。重新运行同一行命令即可重新登录或更新。

维护者发布：`npm run package:xjtlu` 生成 `dist/site/`（指南 `index.html`、`install.sh`、ASCII 包装后的 `install.ps1`、工具包 ZIP），推送到 `gh-pages` 分支。`dist/xjtlu-core-guide.html` 是同一份指南，可直接作为文件发送。也可以手动下载 ZIP 后双击 `START-MAC.command` / `START-WINDOWS.cmd`（此方式需要已安装 Node.js 20+）。

前置条件：Chrome 或 Edge，以及支持本地 stdio MCP 的 AI 客户端（Codex、Claude Desktop、Cursor、Windsurf）。需要可访问学校站点、GitHub Pages 和 npm 源的网络。

安装器会把程序放到 `~/.xjtlu-session-mcp/app`（Windows 对应用户主目录），安装 npm 依赖，并引导学生完成学校 SSO 登录。每接入一个 AI 客户端都会单独确认，原有配置保留，修改前生成带时间戳的备份。

请在安装器新开的 **MCP 专用浏览器窗口** 完成登录。平时使用的 Chrome、Codex 内置浏览器与本工具使用不同的会话，已有登录不会自动同步。终端会区分浏览器启动、学校入口加载、SSO 表单加载与会话保存；只有提示「MCP 专用会话已保存」才完成接入。

这个窗口是不受调试协议控制的普通 Chrome / Edge（独立 profile `~/.xjtlu-session-mcp/login-browser`）。原因：学校认证中心 `uim.xjtlu.edu.cn` 的网关会拒绝 `navigator.webdriver` 为真的浏览器，带 `--enable-automation` 或 `--remote-debugging-port` 启动时，`/ngw/context` 和登录脚本一律返回 HTTP 400，表单白屏（2026-10-16 在 macOS + Chrome 155 用全新 profile 对照确认）。工具不隐藏或伪造自动化标记：账号密码由学生本人在普通窗口输入；工具只读取 Chrome 自带网络日志里的请求地址和状态码（默认模式不含 Cookie，结束后删除），看到 Moodle 首页返回 200 即让浏览器正常退出，再以无头方式只访问 Moodle 站点读取并校验会话。

曾被旧版本自动化浏览器访问过认证中心的 `~/.xjtlu-session-mcp/browser-profile` 会带有被网关标记的持久 Cookie，即使改用普通窗口打开也会 400，因此新版本不再使用它，可以手动删除。

重启 AI 客户端，确认看到 `moodle_*` 工具，然后试着问：

- 列出我的西浦课程，包括归档学年。
- 看一下 MTH129 的课程目录，列出讲义和实验资料。
- 读取这门课的作业和测验截止时间，不开始任何测验。
- 阅读 Lecture 1，并总结前五页。
- 将这门课的可见课件保存到我的本地文件夹。

## 开发目录运行

```bash
npm ci --ignore-scripts
node bin/xjtlu-cli.js setup
node bin/xjtlu-cli.js status
node bin/xjtlu-cli.js web
```

本地页面为 `http://127.0.0.1:3891`，仅绑定回环地址；关闭终端或 Ctrl+C 停止。不使用网页时无需常驻运行，MCP 客户端会自行启动 stdio 进程。

直接启动 MCP：`node bin/xjtlu-cli.js serve`。不要把交互式 `setup` 或 `web` 当作 MCP 服务命令。

## 手动配置

运行 `node bin/xjtlu-cli.js config` 获取当前电脑的准确 JSON。Claude Desktop / Cursor 等使用如下结构，必须把路径替换为本机绝对路径：

```json
{"mcpServers":{"xjtlu-core":{"command":"/absolute/path/to/node","args":["/absolute/path/to/bin/xjtlu-cli.js","serve"]}}}
```

Codex 使用 TOML。自动向导会写入以下同等配置并备份原文件：

```toml
[mcp_servers.xjtlu-core]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/bin/xjtlu-cli.js", "serve"]
```

自动检测没有列出自己的 AI 应用时，手动添加即可。Claude Code 也可以手动执行 `claude mcp add --scope user xjtlu-core -- node /absolute/path/to/bin/xjtlu-cli.js serve`。

## 命令与环境变量

| 命令 | 用途 |
| --- | --- |
| `setup` | 首次登录、选择下载目录、接入 AI 应用 |
| `login` | 重新登录 |
| `status` | 验证学校登录状态 |
| `config` | 输出本机 MCP 启动配置 |
| `serve` | stdio MCP，默认命令 |
| `web` | 可选本地课程操作页面 |

`--url https://core.xjtlu.edu.cn` 可切换当前学年站点；需重新运行 `login`，并确认新站点兼容性。当前实测目标是 AY25/26 归档站；其他学年不作兼容性保证。

| 环境变量 | 作用 |
| --- | --- |
| `XJTLU_URL` | 覆盖学校地址 |
| `XJTLU_MCP_HOME` | 覆盖配置、会话和下载索引目录 |
| `XJTLU_MCP_DOWNLOADS` | 覆盖课件保存目录 |
| `XJTLU_MCP_BROWSER` | 指定 chrome、msedge 或 chromium |

如果配置了环境变量，自行确保 MCP 客户端进程也使用同样的值。

## 登录与数据

密码和验证码在学校页面中输入；工具保存的是会话 Cookie，不是学校密码。会话文件和独立浏览器配置位于 `~/.xjtlu-session-mcp`，按密码级别保管。macOS/Linux 会话文件权限为 `0600`，Windows 依赖用户目录 ACL。不要把这个目录分享给别人。

优先使用保存的 Cookie。站点跳转回登录页时，会用独立浏览器配置无界面检查一次 Moodle 会话（不进入学校认证中心，以免 profile 被网关标记）；Moodle 会话已失效时需要运行 `login` 重新登录。不会自动完成验证码。未实际测量西浦会话的最长有效时长。

工具不提供提交作业、开始测验、发帖、修改成绩或任意 API 调用。课程列表只允许一个已知的只读 Moodle AJAX POST 方法；其他数据读取走已限制路径的 GET。正常访问页面可能产生学校自身的访问日志或自动完成标记，与手动浏览相同，不能承诺完全没有服务器状态变化。

课件和 Cookie 留在本地，但 MCP 返回的课程文字会由你选择的 AI 客户端处理。使用云端 AI 时，这些文字可能发送到对应模型服务。请遵守课程的 AI 使用要求，不公开传播课件。

## 已知范围

- `moodle_list_courses` 优先使用 Moodle 课程 AJAX 接口，最多分页 30 次，每次 100 条。服务未开放时会明确报错；可使用 `visible_only: true` 读取首页可见课程，并明确标记不完整。
- 课程目录和作业列表来自可见 HTML。测验详情可读取已存在的完成情况和成绩，不开始新尝试；日期保留学校页面的原始显示，不擅自套用电脑时区。
- 支持 PDF、DOCX、HTML 和文本提取。扫描版 PDF 没有 OCR，PPTX、ZIP、视频等仅保存。文件实际响应最大 60 MB，下载过程强制限制，不只信任文件元数据。
- 批量保存扫描课程可见资源、文件夹、页面里的直接文件链接；不承诺抓取外站、论坛附件或嵌套活动中的所有资料。默认最多 150 个文件。相同内容按 SHA-256 去重，不覆盖同名的不同内容。当前版本每次会请求远端文件确认内容，尚未实现条件请求缓存。
- 本地课程 HTML 导出是目录快照，正文课件不内嵌。分享给学生使用的 HTML 安装指南是另一份独立文件。
- MCP 的保存/读取文件工具会写本地磁盘，工具注解明确标记；其余工具声明为读取工具。

## 排错与卸载

登录失效：运行 `node ~/.xjtlu-session-mcp/app/bin/xjtlu-cli.js login`，或在本地管理页面点击连接。Windows 请使用自己的用户目录路径。

客户端找不到工具：重启客户端；确认配置中的 Node 和脚本绝对路径存在；确认命令最后是 `serve`。

无法访问学校：先在普通浏览器测试同一地址，再检查网络或校园 VPN。npm 安装失败：确认 Node/npm 可用以及网络能访问 npm registry。

卸载：先从已接入 AI 客户端删除名为 `xjtlu-core` 的 MCP 配置（或恢复安装时的备份），关闭本地服务，再删除 `~/.xjtlu-session-mcp`。下载的课件默认在 `Documents/XJTLU Core`，单独决定是否保留。无需修改学校账号或密码。

## 验证

```bash
npm test
npm run package:xjtlu
```

登录完成后，维护者可运行 `node scripts/verify-xjtlu-live.mjs --course-id <课程ID> --resource-id <课件活动ID>`，通过真实 MCP 客户端验证状态、课程、活动、文件下载和文字提取。此脚本会保存一份课件到本地，只打印数量和耗时，不打印 Cookie、成绩或课件正文。

测试使用假 Moodle 服务器和真实 stdio MCP 客户端，涵盖解析、课程分页、Cookie 范围、重定向边界、文件去重、会话失效、客户端配置合并和本地网页接口。浏览器站点检查与新 MCP 真机验证结果应分别记录，不能互相替代。

真机记录（2026-10-17，macOS，Chrome 155，AY25/26 归档站）：MCP 专用窗口登录并保存会话成功；`verify-xjtlu-live.mjs --course-id 5331 --resource-id 84827` 经真实 stdio MCP 7/7 通过（课程列表完整、课程详情、作业/测验、活动、文件列表、PDF 下载 581076 字节并提取文字）。同日经真实 stdio MCP 调用 `moodle_save_course_files` 保存课程 5331：扫描 81 个文件链接，81 个成功、0 个失败，磁盘去重后 76 个文件约 37.5 MB，PDF 文件头全部有效；重复执行不新增文件。设为「嵌入显示」的资源页会先出现 `?embed=1` 的 iframe 地址，下载时取第一个符合白名单的链接。

Windows 部分按参考仓库 canvas-session-mcp 的做法实现（npm 这类 `.cmd` 包装脚本通过 shell 启动，每个参数加引号后拼成一条命令行；浏览器从 Chrome / Edge 标准安装位置查找；登录完成后用不带 `/F` 的 `taskkill` 让浏览器正常退出），**未在 Windows 真机验证**。Linux、Edge 与本地网页的「连接学校账号」按钮同样未在真实站点上单独验证。
