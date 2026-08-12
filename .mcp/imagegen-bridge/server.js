import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const url = process.env.IMG_URL;
const token = process.env.IMG_TOKEN;

if (!url) {
  console.error("[imagegen-bridge] IMG_URL 环境变量未设置");
  process.exit(1);
}

function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, function (m, name) {
    return process.env[name] || "";
  });
}

const headers = {};
const resolvedToken = expandEnv(token);
if (resolvedToken) headers.Authorization = "Bearer " + resolvedToken;

const remote = new Client({ name: "imagegen-bridge", version: "1.0.0" });
const remoteTransport = new SSEClientTransport(new URL(url), {
  requestInit: { headers }
});

async function shutdown(code) {
  try {
    await remoteTransport.close();
  } catch (e) { /* ignore */ }
  process.exit(code);
}

process.on("SIGINT", function () { shutdown(0); });
process.on("SIGTERM", function () { shutdown(0); });
process.on("uncaughtException", function (err) {
  console.error("[imagegen-bridge] uncaught:", err);
  shutdown(1);
});

await remote.connect(remoteTransport);

let tools = [];
try {
  const list = await remote.listTools();
  tools = list.tools || [];
} catch (e) {
  console.error("[imagegen-bridge] 获取远程工具列表失败:", e.message);
  shutdown(1);
}

const server = new Server(
  { name: "imagegen-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async function () {
  return { tools: tools };
});

server.setRequestHandler(CallToolRequestSchema, async function (request) {
  const name = request.params.name;
  const args = request.params.arguments || {};
  try {
    const result = await remote.callTool({ name: name, arguments: args });
    return result;
  } catch (e) {
    return {
      content: [{ type: "text", text: "[imagegen-bridge] 调用失败: " + (e.message || String(e)) }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[imagegen-bridge] 就绪，已桥接 " + tools.length + " 个工具");
