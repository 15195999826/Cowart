# Cowart · Codex 适配层

目前是空的：Codex 直接用上游原生实现（根目录 `.mcp.json`、`.codex-plugin/`、MCP Apps widget）。

以后给 Codex 加新功能时放在这里，接入方式和 Claude 适配层一样：包一层 MCP 代理，把上游服务当黑盒子进程，追加或改写工具；要改画布页面时，在代理转发 `ui://widget/cowart/canvas.html` 资源时注入脚本，经 `window.__cowartEditor` 操作画布。两边共用的代码放 `adapters/shared/`。

让 Codex 用上这里的代码，需要把插件入口指向本目录的启动脚本——这会改动上游的插件清单，属于「补丁点」，按 FORK.md 登记。
