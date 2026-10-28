# 第三方组件声明

本插件不依赖任何 npm 包（`package.json` 无 `dependencies`，测试也只用 `node:test`）。
随包内置的第三方代码只有下面这一份，用于**从 PDF 里取文字层**（不渲染、不截图）。

## PDF.js（pdfjs-dist 5.6.205）

- 文件：`vendor/pdfjs/pdf.mjs`（491,666 B）、`vendor/pdfjs/pdf.worker.mjs`（1,298,206 B）
- 许可：Apache License 2.0，原文见 `vendor/pdfjs/LICENSE`（10,174 B）
- 来源：`pdfjs-dist@5.6.205` 的 legacy 构建（ESM），文件名由 `build/pdf.mjs`、`build/pdf.worker.mjs` 改来，内容未改
- 用途：`lib/pdf-text.js` 里 `extractPdfText()` 调用 `getDocument()` + `page.getTextContent()`，只取文字层
- 未内置的部分：`standard_fonts/`（渲染用）、`cmaps/`（CJK 编码映射用）。实测本机作业里取不到字的 PDF 是**图片型（无文字层）**，不是缺 CMap，所以不带；若将来真碰到缺 CMap 的文件，按单个 `.bcmap` 补进 `vendor/pdfjs/cmaps/`，仍然不是装依赖

Node 里运行需要三个浏览器 API 的空壳（`DOMMatrix` / `ImageData` / `Path2D`），在 `lib/pdf-text.js` 顶部用 20 行 polyfill 补，不引入 `@napi-rs/canvas`。pdfjs 加载时会往 stderr 打一行
`Warning: Cannot load "@napi-rs/canvas" package`——那是它在找可选的渲染后端，取文字层不需要，可以忽略。
