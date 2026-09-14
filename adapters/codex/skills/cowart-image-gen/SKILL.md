---
name: cowart-image-gen
description: Generate and place a final AI bitmap on the shared Cowart canvas, replacing an AI image holder or inserting into the responsible page. Handles queued Codex imagegen requests without duplicating service-run generation.
---

# Cowart 生图并放回画布

使用现有 `cowart_mcp` 工具读写全机共享画布，不传 `projectDir` / `canvasDir`，不例行调用 `render_cowart_canvas_widget`。Codex 和 Claude 可以操作同一 page；用户明确要求打开或接管时才使用 `cowart-open-canvas`。

## 确定请求和目标

- 收到 `Cowart 画布请求 #N`：先按同插件 `cowart` skill 的队列流程 `get_cowart_request { id, requestKey }`，key 原样取自通知或请求列表，保存原文中的目标 holder、模型、参数、素材和 `pageId`。已完成、失败、跳过、撤销或由服务执行的请求不重复生成；开工回 `running`，结束回 `done` / `failed`，每次 `reply_cowart_request` 都带读取结果的同一个 `requestKey`。
- 用户在对话里直接要求生图：`get_cowart_selection` 读取本会话面板的选择。恰好一个选择具有 `isAiImageHolder: true` 或 `meta.cowartAiImageHolder: true` 时，以它为目标。新 holder 是 `frame`，旧 `geo` holder 也支持。
- 队列已给出 holder / page 时沿用它们，不用执行时刚好选中的其它卡片替代。没有 holder 也能生图：放到本会话负责的页；尚未负责页时使用本会话面板正看的页。

## 生成

按用户或请求指定的模型生成。`Codex imagegen` 使用当前可用的内置 imagegen 工具及其 skill；明确指定猛兽时用可用的 `beast-gen` 工作流。服务已经执行的 AI 图片 / 视频任务无需模型再提交一次。

有 holder 时从其 `props.w` / `props.h` 取得目标宽高，将宽高和比例写进生成提示词，例如 `512 × 683 canvas units, portrait 3:4`。构图按目标比例，不靠后期拉伸或裁切；实际生成比例略有差异时插入工具会等比居中。用户要求文案、标题、海报字或 UI 文本时直接纳入生成提示词，除非明确要求其它排字方式。

使用本次生成工具明确返回的本地输出路径，不凭旧输出目录里「最新一张」猜结果。若只有内联输出，使用工具支持的输出落盘方式；仍无法获得本次产物文件时说明限制，不用旧图顶替。文件使用唯一名称，不覆盖原图。已在对话中看到生成结果时无需再重复图片分析；只有本地路径且尚未看过时才检查该图。

## 插入

通过 `insert_cowart_image` 插入，工具会把本地图片拷入目标页素材目录并保存；**不要自己复制到共享画布目录，也不要手写 tldraw 记录或调用整张保存**。

替换 holder：

```json
{
  "imagePath": "/absolute/path/to/new-image.png",
  "pageId": "page:original-request-page",
  "anchorShapeId": "shape:requested-holder"
}
```

默认替换 holder，保留它的位置与旋转，图片等比放进原框的范围，清除 holder 由工具完成。只有用户要求保留可复用框时传 `replaceAiImageHolder: false`。

没有 holder 时直接插入正常图片；可用非 holder 的已知锚点配 `placement: "right"`。默认采用图片自然比例；多张图依次以上一张返回的 `shapeId` 作锚点，传 `replaceAiImageHolder: false`、`matchAnchor: false`，不把多张拼成一张。

队列结果必须传原 `pageId`，即使用户已翻页或该页后来被接管。直接对话请求省略 `pageId` 可使用服务负责页默认值；别人负责的页被拒绝时不绕过检查，不擅自接管。

检查工具返回的 `shapeId`、目标页、保存素材路径与实际尺寸。已有 widget 自动同步，不再 render；队列请求插入成功后才回 `done`。原作与按标注修改的流程见 `cowart-image-edit`，不要用 holder 替换流程覆盖原图。
