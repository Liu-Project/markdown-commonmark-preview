# Changelog

All notable changes to this project will be documented in this file.

## [0.2.5] - 2026-10-15

### Added

- CommonMark 风格的 Markdown 预览（独立 Webview），主题跟随 VS Code 深色 / 浅色自动切换，无闪烁。
- 编辑与预览双向滚动联动，与 VS Code 内置预览完全一致（行级插值定位、代码块内逐行映射、50ms 节流连续跟动、防循环抑制）。
- 打开预览自动定位到编辑器当前行；图片加载完成后再定位，避免漂移。
- 支持扩展名：`.md` `.markdown` `.mdx` `.mdown` `.mkd` `.rmd` `.qmd` `.txt`。
- 常用编辑命令：加粗、斜体、删除线、行内代码、代码块、数学公式、列表、任务列表、目录生成 / 更新、表格格式化、导出 HTML。
- 渲染能力：KaTeX 数学公式、mermaid 图表、highlight.js 代码高亮、任务列表。

### Fixed

- 修复预览中图片无法渲染的问题：相对路径图片（如 `![](img.png)`、`media/screenshots/light.png` 及原始 HTML `<img>`）现在会转换为 webview 可加载的绝对 URI，并与内置 Markdown 预览行为一致；`localResourceRoots` 同时覆盖扩展 media、文档所在目录与工作区根目录。
