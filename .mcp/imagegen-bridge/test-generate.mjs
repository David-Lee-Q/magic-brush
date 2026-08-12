import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const url = process.env.IMG_URL || "https://8000-f7c2c497f2f22e08.code.cosmoplat.cn/sse";
const token = process.env.IMG_GEN_TOKEN || process.env.IMG_TOKEN || "";

const headers = {};
if (token) headers.Authorization = "Bearer " + token;

const client = new Client({ name: "imagegen-caller", version: "1.0.0" });
const transport = new SSEClientTransport(new URL(url), { requestInit: { headers } });

await client.connect(transport);

const prompt = process.argv[2] || "一只飞行的水墨风格巨龙";
console.log("PROMPT:", prompt);

try {
  const result = await client.callTool({
    name: "generate_image",
    arguments: { prompt: prompt, n: 1, size: "256x256" }
  }, undefined, { timeout: 300000 });
  console.log("=== RESULT ===");
  const text = JSON.stringify(result, null, 2);
  console.log(text.slice(0, 3000));
  if (text.length > 3000) console.log("... (truncated, length=" + text.length + ")");
} catch (e) {
  console.error("CALL FAILED:", e);
  process.exitCode = 1;
}

await transport.close();
process.exit(0);
