import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../web");
const PORT = parseInt(process.env.PORT || "8000", 10);
const IMG_URL = process.env.IMG_URL;
const TINIFY_API_KEY = process.env.TINIFY_API_KEY || "";
const MAX_ATTEMPTS = 3;
const TOOL_TIMEOUT = 240000;
const MAX_CONCURRENCY = 10;
const AUDIT_DIR = path.join(__dirname, "../../logs/audit");
const AGREEMENTS_FILE = path.join(__dirname, "../../logs/agreements.json");
const AUDIT_RETENTION_DAYS = 180;
const AGREEMENT_VERSION = "2026-08-27-2";
const AGREEMENT_TITLE = "神笔马良 · AI 文生图服务用户协议";
const AGREEMENT_CONTENT =
  "神笔马良 · AI 文生图服务用户协议\n" +
  "\n" +
  "一、图片标识说明\n" +
  "1. 本服务生成与展示的图片均含**显式标识（水印）**与**隐式元数据标识**。\n" +
  "2. 用户主动申请下载时，可获取不含显式标识的图片版本；该版本仍保留**隐式元数据标识**（含生成任务编号、调用人标识、生成与下载时间），用于溯源与合规审计，**用户不得移除或篡改**。\n" +
  "\n" +
  "二、用户标识义务\n" +
  "1. 申请下载不带显式标识的图片，即表示用户**确认已阅读并同意本协议**，并对下载图片的后续使用行为负责。\n" +
  "2. 用户不得将本服务生成内容用于**违法违规、侵权、虚假信息、欺诈、色情、危害国家安全**等用途。\n" +
  "\n" +
  "三、使用责任\n" +
  "1. 用户对使用生成内容引发的一切后果**承担全部责任**。\n" +
  "2. 涉及他人肖像、商标、版权作品等的生成与使用，用户应**自行取得必要授权**并承担相应法律责任。\n" +
  "\n" +
  "四、使用记录留存\n" +
  "1. 为保障服务安全与合规，本服务将留存调用记录（含调用人标识、请求参数、输出记录），**留存期限不少于 6 个月**。\n" +
  "2. 调用记录仅用于安全审计与合规管理，不用于其他用途。\n" +
  "\n" +
  "五、其他\n" +
  "本协议如有更新，将在页面公布新版本；用户继续使用本服务即视为接受更新后的协议。";
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

function callerId(req) {
  const v = req && req.headers && req.headers["x-caller-id"]
    ? String(req.headers["x-caller-id"])
    : "";
  return v.slice(0, 64) || "anonymous";
}

function clientIp(req) {
  if (!req || !req.headers) return "";
  const f = req.headers["x-forwarded-for"];
  if (f) return String(f).split(",")[0].trim().slice(0, 64);
  return req.socket && req.socket.remoteAddress
    ? String(req.socket.remoteAddress).slice(0, 64)
    : "";
}

function audit(action, src, extra) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    let caller = "anonymous", ip = "", ua = "";
    if (src && src.headers) {
      caller = callerId(src);
      ip = clientIp(src);
      ua = String(src.headers["user-agent"] || "").slice(0, 300);
    } else if (src) {
      caller = String(src.caller || "anonymous").slice(0, 64);
      ip = String(src.ip || "").slice(0, 64);
      ua = String(src.ua || "").slice(0, 300);
    }
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const iso = now.toISOString().replace("Z", "+08:00");
    const day = iso.slice(0, 10);
    const rec = Object.assign({ ts: iso, action: action, caller: caller, ip: ip, ua: ua }, extra || {});
    fs.appendFileSync(path.join(AUDIT_DIR, day + ".jsonl"), JSON.stringify(rec) + "\n");
  } catch (e) {
    log("审计日志写入失败: " + (e && e.message ? e.message : e));
  }
}

function cleanupAuditLogs() {
  try {
    if (!fs.existsSync(AUDIT_DIR)) return;
    const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const dayMs = new Date(f.slice(0, 10) + "T00:00:00+08:00").getTime();
      if (!Number.isNaN(dayMs) && dayMs < cutoff) {
        try { fs.unlinkSync(path.join(AUDIT_DIR, f)); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

const acceptedAgreements = new Map();

function loadAcceptedAgreements() {
  try {
    const raw = fs.readFileSync(AGREEMENTS_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === "string") acceptedAgreements.set(k, obj[k]);
      }
    }
  } catch (e) { /* ignore */ }
}

function persistAcceptedAgreements() {
  try {
    fs.mkdirSync(path.dirname(AGREEMENTS_FILE), { recursive: true });
    fs.writeFileSync(AGREEMENTS_FILE, JSON.stringify(Object.fromEntries(acceptedAgreements), null, 2));
  } catch (e) {
    log("协议记录写入失败: " + (e && e.message ? e.message : e));
  }
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

function createJob(prompt, n, size, style, source, cfg, ctx) {
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
    updatedAt: Date.now(),
    ctx: ctx || null
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
  if (job.ctx) {
    audit("generate_complete", job.ctx, {
      jobId: job.id,
      total: total,
      done: done,
      status: job.status,
      elapsedMs: Date.now() - started,
      error: String(job.error || "").slice(0, 500)
    });
  }
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

function runPythonScript(b64, metaJson) {
  return new Promise(function (resolve, reject) {
    const script = path.join(__dirname, "finalize-download.py");
    let child;
    try {
      child = spawn("python3", [script, "--meta", metaJson], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "", err = "";
    child.stdout.on("data", function (d) { out += d; });
    child.stderr.on("data", function (d) { err += d; });
    child.on("error", function (e) { reject(e); });
    child.on("close", function (code) {
      if (code !== 0) {
        reject(new Error(String(err).trim() || ("去水印脚本退出码 " + code)));
        return;
      }
      resolve(out);
    });
    child.stdin.on("error", function () { /* ignore */ });
    child.stdin.write(b64);
    child.stdin.end();
  });
}

async function finalizeDownload(body, ctx) {
  let dataUrl = "", jobId = "", index = 0;
  if (body.jobId) {
    const job = jobs.get(String(body.jobId));
    if (!job || !Array.isArray(job.images)) throw new Error("任务不存在或已过期");
    index = Math.max(0, parseInt(body.index, 10) || 0);
    if (index >= job.images.length) throw new Error("图片序号无效");
    dataUrl = String(job.images[index] || "");
    jobId = String(body.jobId);
  } else {
    dataUrl = String(body.imageDataUrl || "");
    if (!/^data:image\/(png|jpe?g);base64,/i.test(dataUrl)) throw new Error("缺少有效的图片数据");
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据格式错误");
  const b64 = dataUrl.slice(comma + 1);
  const meta = {
    app: "shenbi-magic-brush",
    job: jobId,
    index: index,
    caller: ctx && ctx.caller ? ctx.caller : "anonymous",
    generated_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00"),
    agreement_version: AGREEMENT_VERSION,
    note: "隐式元数据标识：本图含调用溯源信息，请勿移除"
  };
  const out = await runPythonScript(b64, JSON.stringify(meta));
  const lines = String(out).split(/\r?\n/);
  const sizeInfo = (lines[0] || "").trim();
  const b64Out = (lines.slice(1).join("") || "").trim();
  if (!b64Out) throw new Error("去水印处理未返回图片");
  const buffer = Buffer.from(b64Out, "base64");
  let width = 0, height = 0;
  const m = /^(\d+)x(\d+)$/.exec(sizeInfo);
  if (m) { width = parseInt(m[1], 10); height = parseInt(m[2], 10); }
  return { buffer: buffer, bytes: buffer.length, width: width, height: height };
}

async function compressWithTinyPng(dataUrl) {
  const apiKey = TINIFY_API_KEY;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片数据格式错误");
  const meta = dataUrl.slice(0, comma);
  const mime = (meta.match(/data:(.*?)(;|$)/) || [null, "image/png"])[1];
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (!buf.length) throw new Error("图片数据为空");
  if (buf.length > 5 * 1024 * 1024) throw new Error("图片超过 5MB，TinyPNG 免费版不支持");
  const auth = "Basic " + Buffer.from("api:" + apiKey).toString("base64");

  const c1 = new AbortController();
  const t1 = setTimeout(function () { c1.abort(); }, 60000);
  let shrinkResp;
  try {
    shrinkResp = await fetch("https://api.tinify.com/shrink", {
      method: "POST",
      headers: { "Content-Type": mime, "Authorization": auth },
      body: buf,
      signal: c1.signal
    });
  } catch (e) {
    clearTimeout(t1);
    throw new Error("TinyPNG 请求失败：" + (e.name === "AbortError" ? "超时(60s)" : (e.message || e)));
  }
  clearTimeout(t1);
  let shrinkBody = {};
  try { shrinkBody = await shrinkResp.json(); } catch (e) { /* ignore */ }
  if (!shrinkResp.ok) {
    const msg = shrinkBody.error || ("HTTP " + shrinkResp.status);
    if (shrinkResp.status === 401) throw new Error("TinyPNG API Key 无效");
    if (shrinkResp.status === 429) throw new Error("TinyPNG 月度配额已用尽");
    if (shrinkResp.status === 422) throw new Error("TinyPNG 无法压缩该图片：" + msg);
    throw new Error("TinyPNG 压缩失败：" + msg);
  }
  const out = shrinkBody.output || {};
  const url = out.url;
  if (!url) throw new Error("TinyPNG 未返回压缩结果");

  const c2 = new AbortController();
  const t2 = setTimeout(function () { c2.abort(); }, 60000);
  let dlResp;
  try {
    dlResp = await fetch(url, { signal: c2.signal });
  } catch (e) {
    clearTimeout(t2);
    throw new Error("压缩图下载失败：" + (e.name === "AbortError" ? "超时(60s)" : (e.message || e)));
  }
  clearTimeout(t2);
  const dlBuf = Buffer.from(await dlResp.arrayBuffer());
  if (!dlResp.ok || !dlBuf.length) throw new Error("压缩图下载失败：HTTP " + dlResp.status);
  const ratio = typeof out.ratio === "number"
    ? out.ratio
    : (buf.length ? dlBuf.length / buf.length : 0);
  return {
    b64: dlBuf.toString("base64"),
    mime: out.type || mime,
    width: out.width || 0,
    height: out.height || 0,
    bytes: dlBuf.length,
    originalBytes: buf.length,
    ratio: ratio
  };
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

function readBody(req, maxBytes) {
  const limit = maxBytes || 1024 * 1024;
  return new Promise(function (resolve, reject) {
    let body = "";
    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > limit) {
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
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "无效的路径编码" });
    return;
  }
  const startedAt = Date.now();
  const finish = function (code) {
    log(req.method + " " + pathname + " -> " + code + " " + ((Date.now() - startedAt) / 1000).toFixed(1) + "s");
  };

  if (req.method === "GET" && pathname === "/api/agreement") {
    sendJson(res, 200, {
      ok: true,
      version: AGREEMENT_VERSION,
      title: AGREEMENT_TITLE,
      content: AGREEMENT_CONTENT
    });
    finish(200);
    return;
  }

  if (req.method === "POST" && pathname === "/api/agreement/accept") {
    readBody(req).then(function (body) {
      const ver = String(body.version || "");
      if (ver !== AGREEMENT_VERSION) {
        sendJson(res, 400, { ok: false, error: "协议版本无效，请刷新页面后重试" });
        finish(400);
        return;
      }
      const cid = callerId(req);
      acceptedAgreements.set(cid, ver);
      persistAcceptedAgreements();
      audit("agreement_accept", req, { version: ver });
      sendJson(res, 200, { ok: true });
      finish(200);
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "请求格式错误" });
      finish(400);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/download") {
    readBody(req, 10 * 1024 * 1024).then(function (body) {
      const ctx = {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      };
      if (acceptedAgreements.get(ctx.caller) !== AGREEMENT_VERSION) {
        sendJson(res, 403, {
          ok: false,
          error: "请先阅读并同意《" + AGREEMENT_TITLE + "》",
          needAgreement: true
        });
        finish(403);
        return;
      }
      finalizeDownload(body, ctx).then(function (result) {
        audit("download", ctx, {
          jobId: body.jobId ? String(body.jobId) : "",
          index: body.jobId ? (Math.max(0, parseInt(body.index, 10) || 0)) : "",
          mode: body.jobId ? "job" : "upload",
          width: result.width,
          height: result.height,
          bytes: result.bytes
        });
        const idx = body.jobId ? (Math.max(0, parseInt(body.index, 10) || 0)) : 0;
        const fname = "shenbi-" +
          (body.jobId ? String(body.jobId) : "img-" + Date.now()).slice(0, 40) +
          "-" + idx + ".png";
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "Content-Disposition": "attachment; filename=\"" + fname + "\""
        });
        res.end(result.buffer);
        finish(200);
      }).catch(function (e) {
        sendJson(res, 500, { ok: false, error: "下载处理失败：" + (e && e.message ? e.message : "未知错误") });
        finish(500);
      });
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "请求格式错误" });
      finish(400);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/compress") {
    readBody(req, 10 * 1024 * 1024).then(function (body) {
      const ctx = {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      };
      const imageDataUrl = String(body.imageDataUrl || "");
      if (!TINIFY_API_KEY) {
        sendJson(res, 500, { ok: false, error: "压缩服务未配置 TINIFY_API_KEY，请联系管理员" });
        finish(500);
        return;
      }
      if (!imageDataUrl) {
        sendJson(res, 400, { ok: false, error: "缺少图片数据" });
        finish(400);
        return;
      }
      compressWithTinyPng(imageDataUrl).then(function (result) {
        audit("compress", ctx, {
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          originalBytes: result.originalBytes,
          ratio: +result.ratio.toFixed(4)
        });
        sendJson(res, 200, {
          ok: true,
          imageDataUrl: "data:" + result.mime + ";base64," + result.b64,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          originalBytes: result.originalBytes,
          ratio: result.ratio
        });
        finish(200);
      }).catch(function (e) {
        sendJson(res, 502, { ok: false, error: e && e.message ? e.message : "压缩失败" });
        finish(502);
      });
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "请求格式错误" });
      finish(400);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/generate-3d") {
    readBody(req).then(function (body) {
      const prompt = (body.prompt || "").toString().trim();
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: "提示词不能为空" });
        finish(400);
        return;
      }
      const n = Math.min(4, Math.max(1, parseInt(body.n, 10) || 1));
      const job = createJob(prompt, n, "256x256", "3d_render", "builtin", null, {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      });
      audit("generate", {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      }, {
        jobId: job.id,
        prompt: String(prompt).slice(0, 1000),
        n: n,
        size: "256x256",
        style: "3d_render",
        source: "builtin"
      });
      sendJson(res, 202, { ok: true, jobId: job.id, status: job.status });
      finish(202);
    }).catch(function (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "请求格式错误" });
      finish(400);
    });
    return;
  }

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
      const job = createJob(prompt, n, size, style, source, cfg, {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      });
      audit("generate", {
        caller: callerId(req),
        ip: clientIp(req),
        ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 300)
      }, {
        jobId: job.id,
        prompt: String(prompt).slice(0, 1000),
        n: n,
        size: size,
        style: style,
        source: source
      });
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
        audit("debug", req, { base: String(body.baseURL || "").slice(0, 200) });
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
  loadAcceptedAgreements();
  cleanupAuditLogs();
  setInterval(cleanupAuditLogs, 24 * 3600 * 1000).unref();
  if (!IMG_URL) log("警告: IMG_URL 未设置，/api/generate 将不可用");
});
