# 需求文档：神笔马良文生图工具

## Introduction

神笔马良文生图工具是一个自包含的单页 Web 应用。用户输入提示词，应用调用 OpenAI 兼容格式的文生图 API 生成图片，支持参数调节、一次生成多图、历史记录、图片下载与图生图功能。

## Glossary

- **System**: 神笔马良文生图工具
- **API**: 用户配置的 OpenAI 兼容文生图接口（如 `https://api.openai.com/v1`、通义万相、智谱等）
- **提示词**: 用户输入的图片内容描述文本
- **图生图**: 上传一张参考图片，结合提示词生成新图片
- **历史记录**: 保存在浏览器本地（localStorage）中的生成记录

## Requirements

### Requirement 1: 基础文生图

**User Story:** AS 用户, I want 输入提示词后生成图片, so that 快速获得想要的图片。

#### Acceptance Criteria

1. WHEN 用户输入非空提示词并点击"生成"按钮, the System SHALL 调用 API 生成图片并在页面展示。
2. IF 提示词为空, the System SHALL 禁止发起生成并提示用户输入提示词。
3. WHILE API 请求进行中, the System SHALL 显示加载状态并禁用生成按钮防止重复提交。

### Requirement 2: 参数调节

**User Story:** AS 用户, I want 调节生成参数, so that 控制图片尺寸、数量与质量。

#### Acceptance Criteria

1. WHEN 用户选择图片尺寸, the System SHALL 将尺寸参数传给 API（如 `1024x1024`）。
2. WHEN 用户设置生成数量（1-4 张）, the System SHALL 将数量参数传给 API 并生成对应张数。
3. IF 用户选择风格或附加参数, the System SHALL 在 API 支持的情况下透传对应参数。

### Requirement 3: 多图对比

**User Story:** AS 用户, I want 一次生成多张图, so that 对比选择最满意的结果。

#### Acceptance Criteria

1. WHEN API 返回多张图片, the System SHALL 以网格方式并列展示所有图片。
2. WHEN 用户点击某张图片, the System SHALL 打开大图预览。
3. WHEN API 返回 `n` 参数结果与请求不符, the System SHALL 按实际返回结果展示。

### Requirement 4: 图片下载

**User Story:** AS 用户, I want 下载生成的图片, so that 保存到本地使用。

#### Acceptance Criteria

1. WHEN 用户点击某张图片的下载按钮, the System SHALL 以图片为文件名下载到本地。
2. IF 图片以 `b64_json` 返回, the System SHALL 在浏览器端解码后提供下载。
3. IF 图片以 URL 返回, the System SHALL 先获取图片再提供下载。

### Requirement 5: 历史记录

**User Story:** AS 用户, I want 查看历史生成记录, so that 回看之前的生成结果。

#### Acceptance Criteria

1. WHEN 每次生成成功, the System SHALL 将记录保存到浏览器 localStorage。
2. WHEN 用户打开历史记录面板, the System SHALL 展示按时间倒序排列的记录。
3. WHEN 用户点击历史记录中的记录, the System SHALL 重新展示对应图片。
4. IF localStorage 超过容量上限, the System SHALL 自动删除最早的记录防止溢出。

### Requirement 6: 图生图

**User Story:** AS 用户, I want 上传参考图结合提示词生成, so that 基于现有图片做二次创作。

#### Acceptance Criteria

1. WHEN 用户上传参考图片, the System SHALL 展示图片预览并允许移除。
2. WHEN 上传了参考图片后点击生成, the System SHALL 向图生图接口提交参考图片与提示词。
3. IF 用户未上传参考图片, the System SHALL 走文生图流程。
4. WHEN 上传图片非图片格式或超出大小限制, the System SHALL 提示用户并拒绝上传。

### Requirement 7: API 配置

**User Story:** AS 用户, I want 配置 API 地址与密钥, so that 对接自己的文生图服务。

#### Acceptance Criteria

1. WHEN 用户打开设置面板, the System SHALL 允许配置 API 基础地址、API Key 与模型名称。
2. WHEN 用户保存配置, the System SHALL 将配置保存在浏览器 localStorage。
3. WHEN 首次使用未配置 API, the System SHALL 提示用户先完成配置。

### Requirement 8: 错误处理

**User Story:** AS 用户, I want 清晰的错误提示, so that 知道请求失败原因。

#### Acceptance Criteria

1. IF API 请求失败, the System SHALL 展示错误信息与对应 HTTP 状态码。
2. IF 请求因 CORS 被拦截, the System SHALL 提示可能的原因并给出解决建议。
3. IF 用户未配置 API Key, the System SHALL 提示进入设置完成配置。
