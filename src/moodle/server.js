import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MoodleClient } from './client.js';
import { registerMoodleTools } from './tools.js';

export async function startMoodleServer() {
  const server = new McpServer({ name: 'xjtlu-session-mcp', version: '0.1.0' });
  registerMoodleTools(server, new MoodleClient());
  await server.connect(new StdioServerTransport());
  return server;
}
