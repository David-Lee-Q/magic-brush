# 需求文档：页面布局与 UI 优化

## Introduction

神笔马良文生图工具是一个毛笔国风主题的单页 Web 应用。本需求对现有页面进行视觉主题精修、交互动效增强与窄屏响应式适配。整体保持「左侧控制面板 + 右侧结果/历史」两列布局，不改变信息架构。

## Glossary

- **System**: 神笔马良文生图工具页面
- **主题令牌**: 定义于 `styles.css` 根选择器中的颜色、圆角、阴影、间距常量
- **两列布局**: 视口宽度 1100px 及以上时，左侧控制面板与右侧结果/历史面板的并列排布
- **控制面板**: 左侧提示词、模式、参数、设置入口所在面板
- **结果面板**: 右侧生成结果与历史记录所在面板

## Requirements

### Requirement 1: 视觉主题统一

**User Story:** AS 用户, I want 一致的国风视觉, so that 界面协调美观。

#### Acceptance Criteria

1. WHEN 应用渲染页面背景与面板, the System SHALL 使用宣纸米白色底色与墨色文本的主配色。
2. WHEN 渲染标题、正文与辅助信息, the System SHALL 分别使用有明确区分的字号与字重层次。
3. WHEN 渲染卡片与面板, the System SHALL 使用统一的 12px 圆角、细边框与柔和阴影。
4. WHEN 渲染任意页面区域, the System SHALL 仅使用主题令牌定义的色彩与样式取值。

### Requirement 2: 图标与控件统一

**User Story:** AS 用户, I want 统一的图标与控件反馈, so that 操作状态清晰可辨。

#### Acceptance Criteria

1. WHEN 渲染导航与操作图标, the System SHALL 使用统一的线性描边风格。
2. WHEN 用户悬停可交互控件, the System SHALL 在 150 毫秒内呈现背景或颜色变化。
3. WHEN 控件处于禁用状态, the System SHALL 降低不透明度并使用禁用光标标识。

### Requirement 3: 交互动效与反馈

**User Story:** AS 用户, I want 流畅的动效反馈, so that 操作过程直观可感知。

#### Acceptance Criteria

1. WHEN 用户提交生成任务, the System SHALL 展示毛笔书写加载动画并禁用生成按钮。
2. WHEN 生成图片就绪, the System SHALL 以淡入并轻微上移的动画呈现图片。
3. WHEN 灯箱、设置面板或帮助页面打开与关闭, the System SHALL 在 200 毫秒内完成过渡动画。
4. WHEN 弹出提示消息, the System SHALL 以滑动淡入动画展示并在 3 秒内自动消退。
5. IF 在提示展示期间再次触发提示, the System SHALL 逐条顺序展示，避免重叠。

### Requirement 4: 布局细节优化

**User Story:** AS 用户, I want 规整的版面, so that 内容主次分明易于浏览。

#### Acceptance Criteria

1. WHERE 视口宽度在 1100px 及以上, the System SHALL 以 320px 左侧控制面板加右侧结果区排布。
2. WHEN 结果区域渲染多张图片, the System SHALL 以自适应网格展示，卡片最小宽度为 220px。
3. WHEN 渲染历史记录条目, the System SHALL 展示提示词、线框模式标签、时间/尺寸/风格信息与缩略图。

### Requirement 5: 窄屏响应式适配

**User Story:** AS 用户, I want 窄屏下可用的界面, so that 在移动端也能完成生成与查看。

#### Acceptance Criteria

1. WHERE 视口宽度在 721px 至 1099px, the System SHALL 保持两列并收紧面板间距与网格最小列宽。
2. WHERE 视口宽度在 720px 及以下, the System SHALL 将布局切换为单列并置顶控制面板。
3. WHERE 视口宽度在 720px 及以下, the System SHALL 提供不小于 44px 的可点击区域。
4. WHERE 视口宽度在 720px 及以下, the System SHALL 将灯箱宽度限制在 94vw 内并保持缩放与下载功能可用。

### Requirement 6: 空状态与异常反馈

**User Story:** AS 用户, I want 明确的空态与错误指引, so that 知道当前状态与下一步操作。

#### Acceptance Criteria

1. WHEN 结果区域暂无图片, the System SHALL 展示毛笔主题空状态插图与引导文案。
2. WHEN 历史记录为空, the System SHALL 展示空状态文案。
3. IF 生成结果中存在加载失败的图片, the System SHALL 隐藏该图片并保留其余图片展示。
