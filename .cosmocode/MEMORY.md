# 用户指令记忆

本文件记录了用户的指令、偏好和教导，用于在未来的交互中提供参考。

## 格式

### 用户指令条目
用户指令条目应遵循以下格式：

[用户指令摘要]
- Date: [YYYY-MM-DD]
- Context: [提及的场景或时间]
- Instructions:
  - [用户教导或指示的内容，逐行描述]

### 项目知识条目
Agent 在任务执行过程中发现的条目应遵循以下格式：

[项目知识摘要]
- Date: [YYYY-MM-DD]
- Context: Agent 在执行 [具体任务描述] 时发现
- Category: [运维部署|构建方法|测试方法|排错调试|工作流协作|环境配置]
- Instructions:
  - [具体的知识点，逐行描述]

## 去重策略
- 添加新条目前，检查是否存在相似或相同的指令
- 若发现重复，跳过新条目或与已有条目合并
- 合并时，更新上下文或日期信息
- 这有助于避免冗余条目，保持记忆文件整洁

## 条目

[imagegen MCP 通过本地 stdio 桥接层对接]
- Date: 2026-08-12
- Context: Agent 将远程 imagegen MCP 服务内置到 opencode 时发现
- Category: 环境配置
- Instructions:
  - opencode 的远程 MCP（type: "remote"）仅支持 Streamable HTTP 传输，而 imagegen MCP 服务只提供传统 SSE 端点（GET /sse），因此必须通过本地桥接接入。
  - 桥接方案：`.mcp/imagegen-bridge/server.js` 用 @modelcontextprotocol/sdk 的 SSEClientTransport 连接远程服务，再以 stdio 暴露给 opencode（type: "local"）。
  - opencode.json 中该 MCP 的 URL 与令牌通过 environment 传入（IMG_URL / IMG_TOKEN），令牌勿外泄。
  - IMG_TOKEN 采用环境变量间接引用（值为 ${IMG_GEN_TOKEN}），启动 opencode 前需先 export IMG_GEN_TOKEN=<令牌>；server.js 内置 ${VAR} 展开逻辑兜底，兼容 opencode 未做插值的情况。
  - 远程地址是预览环境访问 URL，属会话级地址，若失效需替换 opencode.json 与桥接环境变量中的 IMG_URL。

[神笔马良 Web 应用由 Node 服务托管并代理 imagegen]
- Date: 2026-08-12
- Context: Agent 将文生图应用接入 imagegen MCP 服务时发现
- Category: 运维部署
- Instructions:
  - 应用已升级为「静态前端 + Node 后端」：运行 `cd /workspace/.mcp/imagegen-bridge && IMG_URL=<sse地址> IMG_TOKEN=<令牌> PORT=8000 node server-http.mjs`。日常启停直接用 `/workspace/start.sh` 与 `/workspace/stop.sh`：start 先 `ss -tln` 查 8000 已启动则幂等返回 0，未启动则清 .next 缓存、注入 IMG_URL/IMG_TOKEN/PORT、nohup 后台起 server-http.mjs、curl 200 就绪后返回 0（失败返回 2）；stop 用 `ss -tlnp` 提取 PID + kill，10s 未释放再 kill -9。改后端或前端静态文件后须重启服务才生效。
  - server-http.mjs 复用 MCP SDK 的 SSEClientTransport 连接 imagegen MCP 服务，对外提供 POST /api/generate（参数 prompt/n/size/style）与 GET /api/health，并托管 /workspace/web 静态文件；前端默认数据源为内置服务，也可在设置中切换自定义 OpenAI 兼容 API。
  - generate_image 工具默认返回 b64_json，文本中按「图片 N（base64 数据）:」分段，服务端据此解析成 dataURL。
  - 图片生成耗时约 6-35 秒，后端 callTool 超时与 HTTP requestTimeout 均设为 300s 以上，预览代理链路实测可用。
  - 曾出现「生成无结果」故障：后端常驻 SSE 连接空闲后被远端关闭，请求报 MCP error -32000 Connection closed。已改为每次请求新建连接 + 失败自动重试（最多 3 次），并增加请求日志与前端耗时显示。1024x1024 实测约 60s，小尺寸（256/512）更快。
  - 曾出现「HTTP 500」故障：预览网关对长请求（30-60s）会超时中断。已改为异步任务模式：POST /api/generate 立即返回 jobId（202），后端后台生成，前端每 2s 轮询 GET /api/status/:jobId 直到 done/error；任务在内存中保留 15 分钟。改后单次请求均为秒级，彻底绕开网关超时。
  - 曾出现「内置服务返回成功但未解析到图片」：用户浏览器缓存了旧版 app.js，新后端已上线但前端仍是旧逻辑。已给静态资源加版本号（?v=N）并在后端对静态响应头加 no-store/no-cache/must-revalidate；此后每次改前端必须把 index.html 里的版本号 +1 并重启服务。
  - 曾出现「自定义 API 报 Failed to fetch / CORS」：浏览器直连第三方 API 被跨域拦截。已改为自定义 API 也统一经后端代理：POST /api/generate 传 source(custom)+baseURL+apiKey+model（图生图再带 imageDataUrl），后端用 fetch 转发——文生图 POST {baseURL}/images/generations（JSON），图生图 POST {baseURL}/images/edits（multipart，DataURL 转 Blob），240s 超时；自定义响应支持 b64_json/b64/url。浏览器端不再有任何直连 fetch，只与同源后端通信，CORS 问题从根上消除。
  - imagegen 服务对并发请求会串行排队，256x256 平时约 7-34s，两个任务并发时单任务实测可长达 160s+，属正常排队现象，前端有「已耗时 X 秒」倒计时，无需惊慌。
  - 调试自定义代理链路可用本地 mock（如 node 起一个返回 {data:[{b64_json}]} 的 OpenAI 兼容服务）直接打后端 POST /api/generate 验证，不必走浏览器。
  - 自定义 API 的 baseURL 字段做归一化：后端会剥离尾部 /images/generations 或 /images/edits，用户粘贴完整端点也能用（前端提示已要求只填到 /v1）。
  - COSMO 平台网关 https://gpt.cosmoplat.com/v1 不支持 OpenAI 兼容文生图：/v1/models 只有 6 个对话/多模态模型（cosmo-mind-coder/nothink/think/turbo/vl/vl-think），调 /images/generations 返回 503 No available channel。图像生成只能走内置 imagegen MCP 服务，自定义模式需配置真正支持文生图的第三方 OpenAI 兼容接口。
  - 曾实测 cosmo-mind-image 模型存在（文生图/图生图均可用），但后续网关将其下线：2026-08-13 起 /v1/models 不再返回该模型，调用报 404 The model 'cosmo-mind-image' does not exist。自定义模式排查图像接口问题时先 GET {base}/models 核对模型列表。
  - cosmo-mind-image 排查结论（2026-08-12 复核）：该模型**文生图可用**（/images/generations 返回 200 + b64_json；/v1/models 列表不含它属正常，列表不完整）；但 **/images/edits 图生图在该网关报 404 model_not_found**（multipart 与 JSON body 两种格式均复现；不带 model 报 invalid_request；cosmo-mind-image-edit/editor/pro/1、cosmo-mind-img2img 等变体均 model_not_found）→ 网关图生图模型池未注册图像编辑模型，属网关侧配置，前端/后端代理无需改动。排查图像接口问题时以实际接口响应为准，勿仅凭 /v1/models 判断。
  - 曾出现「图片裂开/无法显示」：内置服务返回文本中 base64 之后紧跟「实际使用提示词（已翻译/转写）: …」「修订后的提示词: …」等中文文本，旧 extractBase64 把标记后的所有内容都当作 base64 吞入，data URL 被污染导致图片加载失败。已改为逐行提取，遇非纯 base64 字符行即停止（正则 ^[A-Za-z0-9+/=]+$），并用 validate=True 解码校验。修复后历史里已保存的脏 data URL 仍会裂，需清空历史。
  - 已新增「模型调试」功能：设置弹窗底部「模型调试」按钮 → POST /api/debug/model（后端代理，无 CORS），返回归一化 base、GET {base}/models 的模型列表（状态/耗时/错误）、POST {base}/images/generations 最小测试请求（状态/耗时/图片数/响应体截断 2000 字符）；models 超时 15s、generate 超时 20s。前端展示后可在模型列表中选中回填设置弹窗的 model 字段。
  - 实测 COSMO 网关（gpt.cosmoplat.com）的 cosmo-mind-image 模型当前可用（返回 200），但 data[].url 是服务器本地路径（如 /root/.xinference/image/xxx.jpg）、b64_json 为 null，该路径 HTTP 访问 307 跳登录页（HTML），浏览器无法直接展示 → 自定义接口返回的图在网页上显示为裂图，需用户侧配置能返回公网可访问 url 或 base64 的接口。
  - 已解决自定义接口返回本地路径 url 的问题：generateCustom 请求统一带 response_format:"b64_json"（Xinference 类网关会因此返回 base64 而非本地路径）；normalizeCustomResults 改为 async，对公网 url 会用后端 fetchToDataUrl 抓取转 base64（15s 超时）避免浏览器 CORS；本地路径 url（非 http 开头）被跳过。自定义模式"粉色海豚"实测 10s 返回合法 JPEG base64。调试接口 /api/debug/model 的测试请求同样带 response_format。
  - 日志时间统一东八区：log() 用 `new Date(now.getTime()+8*3600*1000).toISOString().replace("Z","+08:00")`，格式如 2026-08-12T15:25:59.032+08:00。
  - 任务并发（2026-08-14 由串行改并发）：createJob 用信号量 acquireSlot/releaseSlot + 等待队列实现 **MAX_CONCURRENCY=10** 并发（原为 queueTail 串行链）；runJob 逐张生成，每张完成即 push 到 job.images 并递增 job.completed，status 接口返回 total/completed 供前端增量展示；done>0 即使部分失败也置 done（error 拼接"第 i 张：…"），全失败置 error。前端据此轮询完成一张即渲染一张，实测 3 任务 256x256 并行约 36s 全部完成。
  - 前端多任务 UI：结果区为任务卡流（#task-list 内 .task-block，prepend 新任务在上），每卡含标题（任务 N · 提示词前 20 字）、状态行、进度条、图片网格；完成态 is-done/进度 100%，失败态 is-err；历史点击用 renderHistoryTask 复用任务卡渲染。生成不再全局禁用按钮，支持连续提交多任务。
  - 时长预估：前端 EST_SEC_BUILTIN/EST_SEC_CUSTOM 静态尺寸表（内置 256≈5s、512≈15s、1024≈90s；自定义更慢约 256≈40s、1024≈130s），estimateSeconds() 按面积比例推算未知尺寸，任务提交时展示"预计 X"，生成中按已完成张数实际耗时更新"预计剩余"。
  - 自定义提示词增强：enhancePrompt(prompt, style) 按 STYLE_DESC 风格映射表把前端 style 转英文描述，统一追加 "masterpiece, best quality, highly detailed"，提升生成图与提示词相关性；仅作用于自定义请求，内置服务有自己的转写逻辑不受影响。
  - 自定义提示词先中译英再增强：generateCustom 调 translateToEnglish()，用网关对话模型 cosmo-mind-nothink（POST {baseURL}/chat/completions，15s 超时，temperature 0.3）把中文提示词译成英文，失败回退原文；结果按原文本做内存缓存（上限 200 条）。实测"一只在月光下展翅的仙鹤，仙气飘飘"→"A crane spreading its wings under the moonlight, ethereal and otherworldly..." 约 1s，全链路约 10s 出图。
  - 自定义接口生成耗时与尺寸强相关（实测 cosmo-mind-image）：256x256 约 5s、512 约 10-30s、1024 约 80-130s；前端自定义模式生成时提示"预计 1-3 分钟"。
  - 尺寸支持：前端新增电脑屏幕（1280x720/1280x800/1024x768）与手机屏幕（720x1280/720x1560/768x1024）预设，均带比例标注；另有"自定义尺寸…"选项（宽高 64-2048，后端透传）。**内置 imagegen 服务有尺寸白名单**（仅 256x256/512x512/1024x1024/1536x1024/1024x1536/1792x1024/1024x1792），任意尺寸会报 Invalid enum value 错误，后端 nearestBuiltinSize() 按宽高比映射到最近预设（如 640x360→1792x1024）并在日志记录映射；**自定义 Xinference 无白名单，任意尺寸透传**（实测 640x384 返回精确 640x384 JPEG）。

[畸形编码路径可导致后端进程崩溃（已修复）]
- Date: 2026-08-18
- Context: Agent 编写安全审计结论时对 server-http.mjs 做黑盒验证发现
- Category: 排错调试
- Instructions:
  - server-http.mjs 中 decodeURIComponent(url.pathname) 对非法转义路径（如 /%）会抛 URIError，异常冒泡导致 Node 进程崩溃（拒绝服务风险）。已用 try/catch 包裹、解析失败返回 400。今后处理 URL pathname 解码必须做异常容错，验证用 curl "http://127.0.0.1:8000/%" 应返回 400 且进程存活。

[内置 imagegen 出图带右下水印（去水印仅限合规下载通道）]
- Date: 2026-08-27
- Context: Agent 排查用户"输出图片带水印"反馈，随后按用户要求历经"撤销→合规功能重新启用（仅下载路径）"
- Category: 排错调试
- Instructions:
  - 内置 imagegen 服务返回的图片在右下角叠加"AI生成"半透明文字水印（白色文字+深色阴影，宽约 62-80px、高 24-25px，贴近右下边角，像素尺寸固定、不随图片尺寸成比例缩放）。
  - 曾实现后端去水印：server-http.mjs 把每张图传给 .mcp/imagegen-bridge/dewatermark.py（python3+opencv，对右下角矩形做整块 cv2.inpaint(TELEA)，区域边距 max(2,0.2%)px、宽 max(80,9.5%w)、高 max(34,3.4%h)）。实测水印区边缘像素 438→4、区外内容零改动。
  - **2026-08-27 上午用户明确要求撤销去水印**，移除 spawn import、dewatermark 函数及 runJob 中调用，恢复原图直出。
  - **2026-08-27 下午合规需求重新启用去水印，但仅限"用户主动申请下载"路径**（POST /api/download），生成（/api/generate）与展示/轮询（/api/status）仍返回带显式标识原图。处理脚本为 .mcp/imagegen-bridge/finalize-download.py（cv2.inpaint 去右下角显式标识 + Pillow 写 PNG tEXt 隐式元数据：app/job/index/caller/generated_at/agreement_version/note），stdout 第一行"宽x高"、第二行 PNG base64（无前缀）。
  - 踩坑教训（仍有效）：水印像素尺寸固定，若再实现检测/修复区域必须给绝对像素下限（宽≥80、高≥34），不能只用百分比。

[TinyPNG 压缩集成（后端内置 key）]
- Date: 2026-08-27
- Context: Agent 按用户要求集成 https://tinypng.com/ 功能，后按用户要求改为后端内置 key
- Category: 运维部署
- Instructions:
  - 压缩走后端代理 POST /api/compress（body 仅 {imageDataUrl}，不再传 key）：key 内置服务端，从环境变量 TINIFY_API_KEY 读取（start.sh 有占位行，注释提示填入 tinypng.com/developers 获取的 key），前端无任何 key 配置入口。
  - 后端 compressWithTinyPng：POST https://api.tinypng.com/shrink（Basic 认证 api:<key>，body 为图片原始二进制，Content-Type 取 dataURL mime），60s 超时；再 GET output.url 取压缩图转 base64 返回。单图上限 5MB（TinyPNG 免费版限制），free 500 张/月；401=key 无效、429=配额用尽、422=无法压缩。未配置 TINIFY_API_KEY 时接口返回 500 "压缩服务未配置 TINIFY_API_KEY"。
  - 前端入口：图片卡片与灯箱「压缩」按钮（compressImage()），成功后 toast 显示体积减少百分比并自动下载；文件名按返回 mime 定扩展名（jpg/png）。
  - 审计 action=compress，记录 width/height/bytes/originalBytes/ratio，不含 key。
  - 验证方式：注入假 TINIFY_API_KEY 后请求返回 502 "TinyPNG API Key 无效" 即说明链路可达 api.tinypng.com 且 key 读取正确。

[合规功能：用户协议 + 审计日志（≥6 个月）+ 调用人标识]
- Date: 2026-08-27
- Context: Agent 按用户四条合规要求实现服务侧功能时发现
- Category: 运维部署
- Instructions:
  - 下载通道 POST /api/download：body 支持 {jobId,index}（内存任务内取图）或 {imageDataUrl}（历史图直传，readBody 上限 10MB）；未同意当前版本协议返回 403 {needAgreement:true}；成功后输出 PNG（去显式标识+隐式元数据），Content-Disposition attachment。
  - 用户协议：GET /api/agreement 返回 {version,title,content}（版本常量 AGREEMENT_VERSION="2026-08-27"）；POST /api/agreement/accept 校验版本后记录到内存 Map 并持久化 logs/agreements.json（重启自动加载）。前端首次进入弹协议窗（#agreement-modal），同意后存 localStorage mb.agreement.v；下载遇 403 自愈：清本地版本标记→重新弹协议→重试。
  - 审计日志：/workspace/logs/audit/YYYY-MM-DD.jsonl，JSONL 按天分片，启动时清理超 180 天的分片（AUDIT_RETENTION_DAYS=180）。action 类型：generate（请求，含 prompt 截 1000/n/size/style/source，不含 apiKey）、generate_complete（输出，含 total/done/elapsedMs/status）、download（输出，含 jobId/index/mode/width/height/bytes）、agreement_accept、debug。每条含 ts(+08:00)/caller/ip/ua。
  - 调用人标识：无账号体系，前端首次访问生成 UUID 存 localStorage mb.callerId，所有请求带 X-Caller-Id 头（fetchJSON 统一注入），后端 callerId() 解析，匿名降级为 "anonymous"。清缓存会换新 UUID，审计靠 UUID+IP+UA 组合定位。

[每次提交都更新前端页面版本信息]
- Date: 2026-08-27
- Context: 用户在本轮合规下载/TinyPNG 压缩功能提交后提出
- Category: 工作流协作
- Instructions:
  - 每次 git 提交前，必须同步更新前端页面版本信息：在 web/index.html 的 #version-modal 版本列表中新增一条版本记录（version-tag + version-desc），描述本次提交覆盖的功能，放在列表最上方（最新在上），版本号递增（如 v1.2.0 → v1.3.0），日期用当天。
  - 与静态资源 ?v=N 版本号 +1 同步执行，二者缺一不可。

[帮助文档开发规范]
- Date: 2026-08-12
- Context: 用户提供《通用帮助文档开发指南》skill，要求基于 README 新建给用户看的帮助文档
- Category: 工作流协作
- Instructions:
  - 面向最终用户的帮助文档按指南第三阶段结构编写：H2=一级章节（功能模块）、H3=二级子页/TAB、H4=三级子功能，层级规范用于目录自动生成。
  - 本项目帮助页为 /workspace/web/help.html（自包含 HTML，引用 styles.css 共享品牌，头部返回生成器），左侧 sticky 目录 + 右侧内容流，JS 自动扫描 #help-content 的 h2/h3/h4 生成三级目录（toc-level-0/1/2）；主页面右上角 header 有「帮助」入口链接。
  - 内容面向最终用户：操作步骤（生成/风格/尺寸/自定义API/历史/FAQ），去掉开发者向的部署、API 说明。
  - 帮助页配图：截图用 Playwright（全局 npm install -g playwright；1.62 需再 `npx playwright install chromium-headless-shell`，headless 用 chromium_headless_shell-1234；必须装中文字体 fonts-wqy-zenhei/microhei 否则中文变方块）。截图脚本在 /tmp/opencode/screenshot-tool.js，访问 http://127.0.0.1:8000/ 截 7 张（01 主界面含 MOCK 结果预览图/02 图生图含已上传参考图/03 自定义尺寸/04 设置弹窗/05 版本信息弹窗/06 历史记录/07 灯箱预览），输出到 /workspace/web/docs/screenshots/，help.html 用相对路径 docs/screenshots/xxx.png 引用（web 静态目录下，直出可访问）。MOCK 数据：结果区用页面 canvas 生成水墨/国风/赛博示例图注入 .image-card 网格；参考图用 DataTransfer 注入 #ref-input 触发真实上传逻辑；历史记录清空 mb.historySeeded+mb.history 后 reload 由 seedMockHistory 注入。header 右侧按钮为 cfg-status + 版本信息(info) + 帮助 + 设置（均为 icon 按钮，36x36）。
