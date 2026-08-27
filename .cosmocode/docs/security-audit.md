# 安全审计结论：神笔马良 AI 文生图工具

## 审计信息

| 项目 | 内容 |
|------|------|
| 审计对象 | 后端服务 `server-http.mjs`、前端静态资源（`web/`）、启停脚本（`start.sh`/`stop.sh`） |
| 审计日期 | 2026-08-18 |
| 审计方法 | 源码审查 + 黑盒验证（畸形输入、越权路径、超时、并发等） |
| 运行环境 | Node.js v22，端口 8000 |

## 总体结论

**审计通过，未发现高危漏洞。** 审计过程中发现 1 个中危可用性问题（畸形编码路径可导致进程崩溃，构成拒绝服务风险），已修复并经黑盒验证；另有 2 项部署观察建议，不影响当前单机个人工具定位。

## 已实施的安全控制

### 1. 静态文件服务防目录穿越

`serveStatic` 对请求路径执行 `path.normalize(path.join(ROOT, p))` 后，强制校验 `filePath.startsWith(ROOT)`，越界请求返回 403（`server-http.mjs:505-512`）。`..` 与绝对路径拼接均被拦截。

### 2. 请求体大小限制

`readBody` 累计超过 1MB 即拒绝请求并销毁连接（`server-http.mjs:528-547`），防止内存被恶意大包耗尽。

### 3. 输入校验

- 提示词非空校验，空提示词返回 400（`server-http.mjs:564-568`）
- 生成数量 `n` 强制钳制在 1-4（`server-http.mjs:570`）
- 数据源 `source` 白名单（仅 `builtin`/`custom`，`server-http.mjs:573`）
- 自定义模式 `baseURL` 必填（`server-http.mjs:582-586`）
- 尺寸经正则解析并按宽高比映射到内置白名单（`server-http.mjs:250-266`）

### 4. 敏感信息保护

- imagegen 令牌仅经环境变量注入，转发时置于 `Authorization: Bearer` 头（`server-http.mjs:65-67`），写入请求头时不落日志
- 日志只记录提示词截断内容（前后缀各 40/120 字符），**不记录** API Key 与令牌（`server-http.mjs:271`、`418`）
- 静态资源响应统一携带 `Cache-Control: no-store, no-cache, must-revalidate`（`server-http.mjs:520-523`），避免内容被缓存扩散

### 5. 无跨域暴露

后端未开放任何 CORS 头，浏览器仅与同源后端通信，第三方站点无法跨域调用生成接口，从根上消除浏览器端 CSRF/跨域滥用面（`server-http.mjs:554-648`）。

### 6. 超时控制全覆盖

| 环节 | 超时 | 位置 |
|------|------|------|
| HTTP 头解析 | 40s | `headersTimeout`（`server-http.mjs:651`） |
| HTTP 请求整体 | 300s | `requestTimeout`（`server-http.mjs:650`） |
| imagegen 工具调用 | 240s | `TOOL_TIMEOUT`（`server-http.mjs:484`） |
| 提示词翻译 | 15s | `translateToEnglish`（`server-http.mjs:107`） |
| 公网图片抓取 | 15s | `fetchToDataUrl`（`server-http.mjs:381`） |
| 调试接口 models/generate | 15s/20s | `debugModel`（`server-http.mjs:197`、`218`） |

所有外部请求均有 AbortController 兜底，避免挂起连接。

### 7. 并发控制

信号量 + 等待队列实现 `MAX_CONCURRENCY=10`（`server-http.mjs:14-33`），防止高并发任务挤兑图像服务与耗尽资源。

### 8. 数据生命周期

生成任务仅驻留进程内存，`setInterval` 每 60s 清理超过 15 分钟的任务（`server-http.mjs:653-658`），不落盘、不留存敏感内容。

### 9. 异常自愈

SSE 连接按请求新建，瞬时错误（连接关闭/超时/网络）自动重试最多 3 次（`server-http.mjs:463-503`），避免单个故障拖垮服务。

## 审计发现及处置

### 发现项 1（中危，已修复）：畸形编码路径导致进程崩溃

**现象**：请求路径含非法转义（如 `/%`）时，`decodeURIComponent` 抛出 `URIError: URI malformed`，异常冒泡为未捕获异常，Node 进程直接退出，构成拒绝服务风险。

**复现**：

```bash
curl "http://127.0.0.1:8000/%"   # 进程崩溃，服务不可用
```

**修复**：对 `decodeURIComponent` 包裹 try/catch，解析失败返回 400（`server-http.mjs:556-563`）。

**验证**（修复后）：

```bash
curl -w "%{http_code}" "http://127.0.0.1:8000/%"   # 400，进程存活
curl -w "%{http_code}" "http://127.0.0.1:8000/"    # 200，服务正常
```

### 观察项 2（部署说明）：服务监听 0.0.0.0

服务监听 `0.0.0.0:8000`（`server-http.mjs:660`）为预览环境外网访问所需，对外入口由平台网关统一管控，属预期行为。

### 观察项 3（建议）：生成接口未做调用方认证

`/api/generate` 等接口未做鉴权，当前定位为单机个人工具（密钥在用户侧，无账号体系），局域网内可被调用。若后续部署到不受信网络，建议前置反向代理访问控制或引入调用方令牌校验。

## 结论

安全控制覆盖输入校验、越权防护、敏感信息保护、超时与并发治理、数据生命周期管理，本次发现的 DoS 隐患已修复并回归验证通过。**结论：可安全用于申报演示与生产使用（在预期单机部署范围内）。**
