import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const url = process.env.IMG_URL || "https://8000-f7c2c497f2f22e08.code.cosmoplat.cn/sse";
const token = process.env.IMG_GEN_TOKEN || "";
const headers = {};
if (token) headers.Authorization = "Bearer " + token;

const client = new Client({ name: "schema-dump", version: "1.0.0" });
const transport = new SSEClientTransport(new URL(url), { requestInit: { headers } });
await client.connect(transport);
const list = await client.listTools();
console.log(JSON.stringify(list, null, 2));
await transport.close();
process.exit(0);
