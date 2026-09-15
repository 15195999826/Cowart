---
name: cowart-image-edit
description: Generate revised AI images from Cowart card-bound annotations, queued annotation requests, or supplied annotation screenshots, and place results beside the originals while preserving originals and annotations.
---

# Cowart 按标注改图

用 Cowart MCP 读取共享页、原图和卡片绑定的标注，生成干净的新图并放在原图旁边。使用现有 widget；不例行 render，不传 `projectDir` / `canvasDir`，不直接修改共享画布文件。

## 读取修改要求

- 收到 `Cowart 画布请求 #N`：先按同插件 `cowart` skill 用 `get_cowart_request { id, requestKey }` 读取原请求、当前状态、目标卡片和 `pageId`；key 原样取自通知或请求列表。已完成、失败、跳过或撤销时不重做。开工回 `running`，结果插入后回 `done`，失败回 `failed`，每次 `reply_cowart_request` 都带读取结果的同一个 `requestKey`。
- 用户直接说「按画布上的标注改」：`get_cowart_canvas_state` 摘要给出标注文字、绑定目标 id 和素材本地路径；按绑定读取，**不用让用户再提供截图，不按距离或颜色猜关联**。多张卡片按各自标注分别处理；目标不明确时结合本会话 `get_cowart_selection`。
- 用户给了标注截图：该截图是这次修改依据。结合已知卡片或画布摘要找干净原图；不要额外把其它卡片上的要求混进来。已有内联图片直接看；只有本地路径且未看过时才用图片查看工具。
- 标注不一定是改图要求：图是用户项目的截图、设计稿，标注写的是对界面、功能的意见或问题（「这个是干嘛的」「去掉这个选项」）时，按意见处理——在对话里逐条回答、在当前项目里改，不生图、不往画布放图，请求回 `done` 并写一句；要改这张图本身（换背景、改颜色）才生成新图。拿不准先问用户。

标注是一次修改要求；注释是常驻背景约束。画布摘要示例：

```text
shape:arrow 「背景换成雪山」 标注（修改要求） → shape:original
shape:note 「保持人物身份」 注释（常驻说明） → shape:original
```

使用干净原图作编辑基础，标注截图补充区域含义；模型输出不带箭头、文字标签、选框、控制点、工具栏。保持原有主体、构图、比例和风格，除非修改要求另有指定。相互冲突且无法合理决定的要求需要澄清，不能默默混合。

## 生成与插入

使用请求指定的生成方式；Codex 内置改图遵循 imagegen 工具和 skill，明确指定猛兽时使用可用的 `beast-gen`。不要覆盖源文件。使用本次生成返回的准确本地路径和唯一文件名，不选取旧生成目录里的历史图。只有结果尚未看过时才补做图片检查。

`insert_cowart_image` 自动拷素材、安排位置并保存，不需要预写页素材目录、手写 tldraw 记录或整张快照：

```json
{
  "imagePath": "/absolute/path/to/annotation-edit-unique.png",
  "pageId": "page:original-request-page",
  "anchorShapeId": "shape:original",
  "placement": "right",
  "margin": 40,
  "matchAnchor": true,
  "replaceAiImageHolder": false,
  "fileName": "annotation-edit-unique.png",
  "shapeMeta": {
    "cowartGeneratedFromAnnotationEdit": true,
    "cowartAnnotationSourceShapeId": "shape:original"
  },
  "altText": "按标注修改后的图片"
}
```

原图位于旧 AI 图片 frame 内时，用外框作为锚点，结果作为同级卡片放在旁边，不能插进原框遮住原图。按请求的原 `pageId` 插入，不随当前翻页改变目标。多个结果分别放在对应原图旁边，不混用锚点。

检查插入返回的页、位置、尺寸与素材路径；画布会自动同步。原图、旧结果、标注和注释保持原位，不替换、不删除、不隐藏、不移动。只有用户明确要求替换原图时才走对应替换需求；完成后清理标注由用户的画布操作决定。
