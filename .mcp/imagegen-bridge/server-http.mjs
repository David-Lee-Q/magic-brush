import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../web");
const PORT = parseInt(process.env.PORT || "8000", 10);
const IMG_URL = process.env.IMG_URL;
const MAX_ATTEMPTS = 3;
const TOOL_TIMEOUT = 240000;
const MAX_CONCURRENCY = 10;
let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount += 1;
    return Promise.resolve();
  }
  return new Promise(function (resolve) { waitQueue.push(resolve); });
}

function releaseSlot() {
  activeCount -= 1;
  const next = waitQueue.shift();
  if (next) {
    activeCount += 1;
    next();
  }
}

function appendJobError(prev, msg) {
  return prev ? prev + "；" + msg : msg;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function log(msg) {
  const now = new Date();
  const s = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
  console.log("[shenbi-server] " + s + " " + msg);
}

function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, function (m, name) {
    return process.env[name] || "";
  });
}

const HEADERS = {};
const resolvedToken = expandEnv(process.env.IMG_TOKEN || "");
if (resolvedToken) HEADERS.Authorization = "Bearer " + resolvedToken;

const jobs = new Map();

const STYLE_DESC = {
  auto: "",
  photorealistic: "photorealistic, ultra sharp details, natural realistic lighting",
  film: "cinematic film still, dramatic lighting, movie color grading, shallow depth of field",
  "3d_render": "high quality 3D render, octane render, blender, unreal engine, PBR, physically based rendering",
  clay: "claymation style, soft clay texture, warm studio lighting, cute",
  anime: "anime style, vibrant colors, clean lineart, highly detailed illustration",
  retro_anime: "retro 90s anime style, vintage cel shading, film grain",
  watercolor: "watercolor painting, soft color washes, textured paper, delicate brushwork",
  ink: "traditional Chinese ink wash painting, elegant brush strokes, flowing ink, artistic",
  oil_painting: "oil painting, rich impasto brushstrokes, textured canvas, classical art",
  sketch: "pencil sketch, monochrome, cross hatching, fine line work",
  pixel: "pixel art, 8-bit retro style, crisp pixels, chunky pixelated graphics",
  cartoon: "cartoon illustration, bold clean outlines, flat colors, playful",
  gothic: "dark gothic fantasy, dramatic shadows, ornate details, moody atmosphere",
  cyberpunk: "cyberpunk aesthetic, neon lights, futuristic cityscape, high contrast, rain reflections",
  vaporwave: "vaporwave aesthetic, retro synthwave, pastel gradients, nostalgic, glitch art",
  holographic: "holographic iridescent effect, prismatic light reflections, futuristic translucent surfaces",
  minimal: "minimalist composition, clean design, lots of negative space, simple elegant",
  retro_hk: "retro Hong Kong style, colorful neon signs, nostalgic 80s city streets, cinematic",
  impressionism: "impressionist painting, loose expressive brushwork, luminous play of light and color"
};

const TRANSLATE_MODEL = "cosmo-mind-nothink";
const TRANSLATE_CACHE = new Map();
const TRANSLATE_CACHE_MAX = 200;

async function translateToEnglish(text, cfg) {
  if (!text) return "";
  if (TRANSLATE_CACHE.has(text)) return TRANSLATE_CACHE.get(text);
  if (!cfg || !cfg.baseURL) return String(text).trim();
  let base = String(cfg.baseURL).trim().replace(/\/+$/, "");
  base = base.replace(/\/images\/(generations|edits)$/i, "");
  const apiKey = cfg.apiKey || "";
  if (!apiKey) return String(text).trim();
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 15000);
  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        messages: [
          {
            role: "system",
            content: "You are a professional translator. Translate the user's Chinese text into an English image-generation prompt. Keep it natural, vivid and detailed. Output ONLY the English translation, no explanation."
          },
          { role: "user", content: String(text) }
        ],
        temperature: 0.3,
        max_tokens: 300
      }),
      signal: controller.signal
    });
    const body = await resp.json().catch(function () { return {}; });
    const out = body && body.choices && body.choices[0] && body.choices[0].message &&
      body.choices[0].message.content
      ? String(body.choices[0].message.content).trim()
      : "";
    if (out) {
      if (TRANSLATE_CACHE.size >= TRANSLATE_CACHE_MAX) {
        const first = TRANSLATE_CACHE.keys().next().value;
        if (first !== undefined) TRANSLATE_CACHE.delete(first);
      }
      TRANSLATE_CACHE.set(text, out);
      return out;
    }
    return String(text).trim();
  } catch (e) {
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

function enhancePrompt(prompt, style) {
  const desc = STYLE_DESC[style] || "";
  const parts = [String(prompt || "").trim()];
  if (desc) parts.push(desc);
  parts.push("masterpiece, best quality, highly detailed");
  return parts.join(", ");
}

function newJobId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function createJob(prompt, n, size, style, source, cfg) {
  const total = Math.max(1, parseInt(n, 10) || 1);
  const job = {
    id: newJobId(),
    status: "pending",
    prompt: prompt,
    params: { n: total, size: size, style: style, source: source },
    total: total,
    completed: 0,
    images: [],
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  jobs.set(job.id, job);
  acquireSlot().then(function () {
    return runJob(job, prompt, total, size, style, source, cfg);
  }).catch(function () { /* 保持任务存活 */ }).finally(function () {
    releaseSlot();
  });
  return job;
}

async function debugModel(cfg) {
  if (!cfg || !cfg.baseURL) throw new Error("未配置 API 基础地址");
  let base = String(cfg.baseURL).trim().replace(/\/+$/, "");
  base = base.replace(/\/images\/(generations|edits)$/i, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-image-1";
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const out = { base: base, model: model, models: null, generate: null };

  const c1 = new AbortController();
  const t1 = setTimeout(function () { c1.abort(); }, 15000);
  const mStart = Date.now();
  try {
    const r = await fetch(base + "/models", { headers: headers, signal: c1.signal });
    let body = null;
    try { body = await r.json(); } catch (e) { /* ignore */ }
    out.models = {
      ok: r.ok,
      status: r.status,
      timeMs: Date.now() - mStart,
      ids: body && Array.isArray(body.data) ? body.data.map(function (m) { return m.id; }) : [],
      error: r.ok ? "" : ((body && body.error && (body.error.message || body.error.type)) || "HTTP " + r.status)
    };
  } catch (e) {
    out.models = {
      ok: false, status: 0, timeMs: Date.now() - mStart, ids: [],
      error: "请求失败：" + (e.name === "AbortError" ? "超时(15s)" : (e.message || e))
    };
  } finally { clearTimeout(t1); }

  const c2 = new AbortController();
  const t2 = setTimeout(function () { c2.abort(); }, 20000);
  const gStart = Date.now();
  try {
    const r = await fetch(base + "/images/generations", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify({ model: model, prompt: "test", n: 1, size: "256x256", response_format: "b64_json" }),
      signal: c2.signal
    });
    let body = null;
    try { body = await r.json(); } catch (e) { /* ignore */ }
    const errMsg = body && body.error ? (body.error.message || body.error.type || "") : "";
    out.generate = {
      ok: r.ok && !!body,
      status: r.status,
      timeMs: Date.now() - gStart,
      imageCount: body && Array.isArray(body.data) ? body.data.length : 0,
      body: body ? JSON.stringify(body).slice(0, 2000) : "",
      error: r.ok ? "" : ("HTTP " + r.status + (errMsg ? "：" + errMsg : ""))
    };
  } catch (e) {
    out.generate = {
      ok: false, status: 0, timeMs: Date.now() - gStart, imageCount: 0, body: "",
      error: "请求失败：" + (e.name === "AbortError" ? "超时(20s)，第三方接口响应过慢" : (e.message || e))
    };
  } finally { clearTimeout(t2); }

  return out;
}

const BUILTIN_SIZES = ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792"];

function nearestBuiltinSize(size) {
  if (!size || BUILTIN_SIZES.indexOf(size) !== -1) return size;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return "1024x1024";
  const ratio = parseInt(m[1], 10) / parseInt(m[2], 10);
  let best = "1024x1024";
  let bestDiff = Infinity;
  for (const s of BUILTIN_SIZES) {
    const p = s.split("x").map(Number);
    const diff = Math.abs(p[0] / p[1] - ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

async function runJob(job, prompt, total, size, style, source, cfg) {
  job.status = "processing";
  const started = Date.now();
  log("job " + job.id + " 开始 source=" + source + " n=" + total + " prompt=" + String(prompt).slice(0, 40));
  let done = 0;
  for (let i = 0; i < total; i++) {
    try {
      let out;
      if (source === "custom") {
        out = await generateCustom(prompt, 1, size, style, cfg);
      } else {
        const actual = nearestBuiltinSize(size);
        if (actual !== size) {
          log("job " + job.id + " 内置尺寸白名单映射 " + size + " -> " + actual);
        }
        out = await generateImage(prompt, 1, actual, style);
      }
      if (out.images && out.images.length) {
        job.images.push(out.images[0]);
        done += 1;
        job.completed = done;
        log("job " + job.id + " 第" + (i + 1) + "/" + total + " 张完成 已用=" + ((Date.now() - started) / 1000).toFixed(1) + "s");
      } else {
        job.error = appendJobError(job.error, "第" + (i + 1) + "张：图片服务未返回图片");
        log("job " + job.id + " 第" + (i + 1) + " 张无返回");
      }
    } catch (e) {
      const msg = e && e.message ? e.message : "图片生成失败";
      job.error = appendJobError(job.error, "第" + (i + 1) + "张：" + msg);
      log("job " + job.id + " 第" + (i + 1) + "/" + total + " 张失败: " + msg);
    }
    job.updatedAt = Date.now();
  }
  job.completed = done;
  job.status = done > 0 ? "done" : "error";
  if (!done && !job.error) job.error = "图片服务未返回图片";
  log("job " + job.id + " 结束 status=" + job.status + " 完成=" + done + "/" + total +
    " 耗时=" + ((Date.now() - started) / 1000).toFixed(1) + "s");
  job.updatedAt = Date.now();
}

async function connectOnce() {
  if (!IMG_URL) {
    const err = new Error("IMG_URL 环境变量未设置，无法连接 imagegen 服务");
    err.noUrl = true;
    throw err;
  }
  const client = new Client({ name: "shenbi-backend", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(IMG_URL), {
    requestInit: { headers: HEADERS }
  });
  await client.connect(transport);
  client.__transport = transport;
  return client;
}

async function closeClient(client) {
  if (client && client.__transport) {
    try { await client.__transport.close(); } catch (e) { /* ignore */ }
  }
}

function extractBase64(text) {
  const parts = text.split(/图片\s*\d+\s*（base64 数据）:/);
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    let b64 = "";
    for (const line of parts[i].split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (t.indexOf("图片") === 0 && t.indexOf("（base64 数据）") > 0) break;
      if (!/^[A-Za-z0-9+/=]+$/.test(t)) break;
      b64 += t;
    }
    if (b64) out.push("data:image/jpeg;base64," + b64);
  }
  return out;
}

function parseResult(result) {
  if (result.isError) {
    const msg = (result.content || []).map(function (c) { return c.text || ""; }).join("\n");
    throw new Error(msg || "imagegen 服务返回错误");
  }
  const images = [];
  const content = result.content || [];
  for (const c of content) {
    if (c.type === "image" && c.data) {
      images.push("data:" + (c.mimeType || "image/png") + ";base64," + c.data);
    }
  }
  const text = content.filter(function (c) { return c.type === "text"; })
    .map(function (c) { return c.text || ""; }).join("\n");
  images.push.apply(images, extractBase64(text));
  return { images: images };
}

function isTransientError(err) {
  const msg = err && err.message ? String(err.message) : "";
  return /connection closed|closed|ECONNRESET|ECONNREFUSED|timeout|timed out|network|socket hang up|fetch failed/i.test(msg);
}

function dataUrlToBlobNode(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  const mime = (meta.match(/data:(.*?)(;|$)/) || [null, "image/png"])[1];
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  return new Blob([buf], { type: mime });
}

async function fetchToDataUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error("空响应");
    return "data:" + ct + ";base64," + buf.toString("base64");
  } finally {
    clearTimeout(t);
  }
}

async function normalizeCustomResults(body) {
  const list = body && Array.isArray(body.data) ? body.data : [];
  const images = [];
  for (const item of list) {
    if (item && item.b64_json) {
      images.push("data:image/png;base64," + item.b64_json);
    } else if (item && item.b64) {
      images.push("data:image/png;base64," + item.b64);
    } else if (item && item.url && /^https?:\/\//i.test(item.url)) {
      const fetched = await fetchToDataUrl(item.url).catch(function () { return null; });
      images.push(fetched || item.url);
    }
  }
  return { images: images };
}

async function generateCustom(prompt, n, size, style, cfg) {
  if (!cfg || !cfg.baseURL) throw new Error("自定义 API 未配置 baseURL");
  let baseURL = String(cfg.baseURL).trim().replace(/\/+$/, "");
  baseURL = baseURL.replace(/\/images\/(generations|edits)$/i, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-image-1";
  const translated = await translateToEnglish(prompt, cfg);
  const sendPrompt = enhancePrompt(translated, style);
  log("翻译后发送: " + String(sendPrompt).slice(0, 120));
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 240000);
  let resp;
  try {
    if (cfg.imageDataUrl) {
      const fd = new FormData();
      fd.append("model", model);
      fd.append("prompt", sendPrompt);
      fd.append("n", String(n));
      fd.append("size", size);
      fd.append("response_format", "b64_json");
      if (style) fd.append("style", style);
      const blob = dataUrlToBlobNode(cfg.imageDataUrl);
      if (!blob) throw new Error("参考图片解析失败");
      fd.append("image", blob, "reference.png");
      resp = await fetch(baseURL + "/images/edits", {
        method: "POST",
        headers: headers,
        body: fd,
        signal: controller.signal
      });
    } else {
      const payload = { model: model, prompt: sendPrompt, n: n, size: size, response_format: "b64_json" };
      if (style) payload.style = style;
      resp = await fetch(baseURL + "/images/generations", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, headers),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }
  } finally {
    clearTimeout(timer);
  }
  const body = await resp.json().catch(function () { return {}; });
  if (!resp.ok) {
    const msg = body && body.error ? (body.error.message || body.error.type || "") : "";
    throw new Error("HTTP " + resp.status + (msg ? "：" + msg : ""));
  }
  return await normalizeCustomResults(body);
}

async function generateImage(prompt, n, size, style) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) log("第 " + attempt + " 次重试生成");
    const client = await connectOnce().catch(function (e) {
      lastErr = e;
      return null;
    });
    if (!client) {
      log("连接 imagegen 失败: " + (lastErr.message || lastErr));
      continue;
    }
    try {
      const args = {
        prompt: prompt,
        n: n,
        size: size,
        response_format: "b64_json"
      };
      if (style) args.style = style;
      const started = Date.now();
      const result = await client.callTool(
        { name: "generate_image", arguments: args },
        undefined,
        { timeout: TOOL_TIMEOUT }
      );
      log("生成成功 prompt=" + prompt.slice(0, 30) + " 耗时=" + ((Date.now() - started) / 1000).toFixed(1) + "s");
      return parseResult(result);
    } catch (e) {
      lastErr = e;
      log("生成失败(尝试 " + attempt + "): " + (e.message || e));
      if (isTransientError(e) && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw e;
    } finally {
      await closeClient(client);
    }
  }
  throw lastErr || new Error("图片生成失败");
}

function serveStatic(req, res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let body = "";
    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", function () {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const startedAt = Date.now();
  const finish = function (code) {
    log(req.method + " " + pathname + " -> " + code + " " + ((Date.now() - startedAt) / 1000).toFixed(1) + "s");
  };

  if (req.method === "POST" && pathname === "/api/generate") {
    readBody(req).then(function (body) {
      const prompt = (body.prompt || "").toString().trim();
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: "提示词不能为空" });
        finish(400);
        return;
      }
      const n = Math.min(4, Math.max(1, parseInt(body.n, 10) || 1));
      const size = body.size || "1024x1024";
      const style = (body.style || "").toString().trim();
      const source = body.source === "custom" ? "custom" : "builtin";
      const cfg = source === "custom"
        ? {
            baseURL: (body.baseURL || "").toString().trim(),
            apiKey: (body.apiKey || "").toString().trim(),
            model: (body.model || "").toString().trim(),
            imageDataUrl: body.imageDataUrl || ""
          }
        : null;
      if (source === "custom" && !cfg.baseURL) {
        sendJson(res, 400, { ok: false, error: "自定义 API 未配置 baseURL" });
        finish(400);
        return;
      }
      const job = createJob(prompt, n, size, style, source, cfg);
      sendJson(res, 202, { ok: true, jobId: job.id, status: job.status });
      finish(202);
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "请求格式错误" });
      finish(400);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/debug/model") {
    readBody(req).then(function (body) {
      return debugModel({
        baseURL: (body.baseURL || "").toString().trim(),
        apiKey: (body.apiKey || "").toString().trim(),
        model: (body.model || "").toString().trim()
      }).then(function (result) {
        sendJson(res, 200, { ok: true, data: result });
        finish(200);
      });
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "调试请求失败" });
      finish(400);
    });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/);
  if (req.method === "GET" && statusMatch) {
    const job = jobs.get(statusMatch[1]);
    if (!job) {
      sendJson(res, 404, { ok: false, error: "任务不存在或已过期" });
      finish(404);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      jobId: job.id,
      status: job.status,
      total: job.total,
      completed: job.completed,
      images: job.images,
      error: job.error
    });
    finish(200);
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, source: "imagegen-mcp" });
    finish(200);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  finish(405);
});

server.requestTimeout = 300000;
server.headersTimeout = 40000;

setInterval(function () {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 15 * 60 * 1000) jobs.delete(id);
  }
}, 60000).unref();

server.listen(PORT, "0.0.0.0", function () {
  log("神笔马良服务已启动: http://0.0.0.0:" + PORT);
  log("静态目录: " + ROOT);
  if (!IMG_URL) log("警告: IMG_URL 未设置，/api/generate 将不可用");
});
