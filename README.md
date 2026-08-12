# 神笔马良 · AI 文生图工具

单页 Web 应用，通过画笔拖拽或文本描述，调用 AI 图像生成服务产出图片。支持内置 imagegen 服务与自定义 OpenAI 兼容 API（文生图 / 图生图）两种数据源。

## 功能特性

- **文生图 / 图生图**：输入中文提示词生成图片；图生图模式下上传参考图片后基于参考图生成
- **双数据源**：
  - 内置服务：开箱即用，无需配置
  - 自定义 API：任意 OpenAI 兼容的图像生成接口，支持 `/images/generations` 与 `/images/edits`
- **风格选择**：内置 20 种风格（水墨、国风、赛博朋克、油画、浮世绘等），自动转为英文描述注入提示词
- **提示词增强**：自定义模式下，中文提示词先自动翻译为英文，再拼接风格描述与质量词后发送，提升生成质量与相关性
- **尺寸预设 + 自定义**：常见比例预设（1:1、3:2、16:9、9:16 电脑/手机屏等），支持自定义宽高（64-2048）
- **异步任务**：生成采用"提交任务 + 轮询状态"模式，避免长请求超时；任务排队串行执行
- **历史记录**：生成图片自动保存到浏览器本地（上限 50 条），支持灯箱预览与下载
- **模型调试**：内置调试面板，可检测自定义接口连通性、模型列表与生成链路
- **毛笔作画动效**：生成期间展示毛笔沿墨迹轨迹作画的 loading 动画

## 快速开始

### 依赖

- Node.js 18+

### 启动服务

```bash
# 1. 安装桥接层依赖
cd .mcp/imagegen-bridge
npm install

# 2. 启动服务（内置 imagegen 服务地址来自环境变量）
IMG_URL="https://<sse-imagegen-host>/sse" \
IMG_TOKEN="<token>" \
PORT=8000 \
node server-http.mjs
```

启动后访问 `http://localhost:8000/` 即可使用。

> 前端静态资源缓存采用 `?v=` 版本号控制，修改前端文件后请同步递增 `web/index.html` 中的版本号。

## 使用说明

### 内置服务

默认数据源。输入提示词、选择风格与尺寸后点击「开始生成」。内置服务支持 7 种固定尺寸：

`256x256` / `512x512` / `1024x1024` / `1536x1024` / `1024x1536` / `1792x1024` / `1024x1792`

选择自定义尺寸时，后端会按宽高比自动映射到最接近的固定尺寸。

### 自定义 API

点击右上角「设置」，切换数据源为「自定义 API」并填写：

| 配置项 | 说明 |
|--------|------|
| API 基础地址 | 如 `https://api.example.com/v1`，自动兼容带 `/images/generations` 后缀的地址 |
| API Key | 请求 Bearer Token |
| 模型 | 图像生成模型名称 |

自定义模式支持：

- 任意尺寸（64-2048），实测自定义尺寸可精确生效
- 图生图（`/images/edits`）
- 提示词自动中译英 + 风格增强
- 生成结果统一转 base64 返回，兼容返回本地路径 url 的网关

## 项目结构

```
.
├── web/                            # 前端（纯静态，无构建步骤）
│   ├── index.html                  # 页面结构，内含毛笔 SVG symbol
│   ├── app.js                      # 前端逻辑（生成/历史/调试/尺寸等）
│   └── styles.css                  # 样式（含移动端适配、毛笔动效）
├── .mcp/imagegen-bridge/           # Node 后端与 MCP 桥接
│   ├── server-http.mjs             # HTTP 服务：静态托管 + 异步任务 + 代理 + 调试接口
│   ├── server.js                   # opencode 本地 stdio 桥接（内置 imagegen 接入）
│   ├── test-generate.mjs           # 生成链路测试脚本
│   └── package.json
├── opencode.json                   # opencode 配置（含内置 imagegen MCP）
└── .cosmocode/                     # 项目文档与记忆
```

## 后端 API

| 接口 | 说明 |
|------|------|
| `POST /api/generate` | 提交生成任务，body 含 `source`(builtin/custom)、`prompt`、`n`、`size`、`style`；custom 需 `baseURL`/`apiKey`/`model`，图生图附 `imageDataUrl` |
| `GET /api/status/:jobId` | 轮询任务状态：`pending`/`processing`/`done`/`error`，完成时返回 `images`（base64 dataURL 数组） |
| `POST /api/debug/model` | 自定义接口连通性检测：归一化 base、模型列表、生成测试（含耗时/响应体） |

任务由后端 Promise 链串行排队执行，避免并发挤兑图像服务。

## 常见问题

- **生成较慢**：自定义接口耗时与尺寸强相关，256x256 约 5s，1024 约 80-130s；任务为串行排队，多个任务需依次等待
- **内置服务不支持图生图**：请切换到自定义 API 模式
- **图片显示为裂图**：自定义网关若返回本地路径 url，后端已自动按 base64 抓取兜底；确认请求携带 `response_format: b64_json`
- **预览域名无法访问**：预览地址末尾不要带 `/`
