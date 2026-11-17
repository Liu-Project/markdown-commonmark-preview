// Automated export feature test runner.
//
// Runs the extension's export pipeline (compiled out/*.js) in a plain Node
// process with a minimal `vscode` API stub, exercising the REAL code paths:
//   - unified self-contained HTML pipeline (buildExportHtml)
//   - HTML / PDF export commands
//   - Chrome detection & headless PDF printing (with outline)
//   - mermaid -> SVG pre-rendering
//   - heading hierarchy toggle, error paths, legacy printToHtml regression
//
// Usage: node test/harness/run.js   (from the repo root; `npm run compile` first)
'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, 'out');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-export-test-'));
const CHROME = '/usr/bin/google-chrome';

// ---- intercept `require('vscode')` ----
const stub = require('./vscode-stub');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return origLoad.apply(this, arguments);
};

// ---- results ----
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---- helper: run a command and capture ----
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 120000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- helper: pdf info ----
function pdfInfo(pdfPath) {
  try {
    const out = run('pdfinfo', [pdfPath]).stdout;
    const info = {};
    for (const line of out.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return info;
  } catch (e) { return {}; }
}
function pdfText(pdfPath) {
  try { return run('pdftotext', [pdfPath, '-']).stdout; } catch (e) { return ''; }
}

// ---- setup ----
const nls = require(path.join(OUT, 'nls'));
nls.config({ extensionContext: { extensionPath: REPO, extensionMode: 1 } });

const exportMod = require(path.join(OUT, 'export'));
const printMod = require(path.join(OUT, 'print'));

const mockContext = {
  extensionPath: REPO,
  extensionMode: 1,
  subscriptions: [],
  asAbsolutePath: (p) => path.join(REPO, p),
};
exportMod.activate(mockContext);
printMod.activate(mockContext);

const { __setConfig, __setConfigDeep, makeTextDocument, makeEditor, state } = stub.__test;

function resetConfig() {
  __setConfigDeep('markdown-commonmark-preview', JSON.parse(JSON.stringify(stub.__test.DEFAULTS['markdown-commonmark-preview'])));
  __setConfigDeep('markdown-commonmark-preview.print', JSON.parse(JSON.stringify(stub.__test.DEFAULTS['markdown-commonmark-preview.print'])));
  __setConfigDeep('markdown-commonmark-preview.export', JSON.parse(JSON.stringify(stub.__test.DEFAULTS['markdown-commonmark-preview.export'])));
  __setConfigDeep('markdown.preview', JSON.parse(JSON.stringify(stub.__test.DEFAULTS['markdown.preview'])));
  __setConfigDeep('markdown', JSON.parse(JSON.stringify(stub.__test.DEFAULTS['markdown'])));
}

function setActiveDoc(fileName, text) {
  const doc = makeTextDocument(fileName, text);
  stub.window.__setActiveEditor(makeEditor(doc));
  return doc;
}
// expose a setter on the stub window
stub.window.__setActiveEditor = (ed) => { state.activeEditor = ed; };
stub.window.__setActiveTab = (input) => {
  stub.window.tabGroups.activeTabGroup.activeTab = input ? { input } : undefined;
};

function clearMessages() { state.messages.length = 0; }
function lastError() { return state.messages.filter((m) => m.level === 'error').map((m) => m.msg).join(' | '); }
function lastInfo() { return state.messages.filter((m) => m.level === 'info').map((m) => m.msg).join(' | '); }

function tmpFile(name) { return path.join(WORK, name); }
function writeDoc(fileName, text) { const p = tmpFile(fileName); fs.writeFileSync(p, text, 'utf8'); return p; }

async function main() {
  const sampleMd = fs.readFileSync(path.join(REPO, 'test', 'samples', 'export-sample.md'), 'utf8');
  // Make ./logo.png resolve for docs written into WORK.
  fs.copyFileSync(path.join(REPO, 'test', 'samples', 'logo.png'), path.join(WORK, 'logo.png'));

  // =====================================================================
  section('A. 统一 HTML 管线（buildExportHtml）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    const samplePath = path.join(REPO, 'test', 'samples', 'export-sample.md');
    const doc = makeTextDocument(samplePath, sampleMd);
    const { html, body, title } = await exportMod.buildExportHtml(doc, {});
    check('A1 标题自动提取（<!-- title: -->）', title === '导出功能验收样例', `title=${title}`);
    check('A2 HTML 包含 <style>（默认带样式）', /<style>/.test(html), 'styles present');
    check('A3 mermaid 预渲染为内嵌 SVG（无需 JS）', (html.match(/class="mermaid-rendered"[\s\S]*?<svg/g) || []).length >= 2, 'mermaid prerendered');
    check('A3b 预渲染后不再内联 mermaid.min.js', !html.includes('__esbuild_esm_mermaid_nm'), 'mermaid runtime skipped');
    check('A3c preview.js 仍内联作兜底', html.includes('__commonmarkRender'), 'preview.js inlined');
    check('A4 .markdown-body 容器包裹', html.includes('<div class="markdown-body">'), 'wrapper');
    check('A5 KaTeX 字体内联为 data:font/woff2', /url\(data:font\/woff2;base64,/.test(html), 'fonts inlined');
    check('A6 相对图片已处理（file:/// 绝对路径）', /file:\/\/\/.*logo\.png/.test(body), 'image abs path');
    check('A7 .md 链接转换为 .html', body.includes('other.html'), 'link converted');
    check('A8 表格/代码/引用结构保留', /<table[ >]/.test(body) && body.includes('language-python') && /<blockquote[ >]/.test(body), 'structure');
    check('A9 主题默认 light（vscode-light）', html.includes('vscode-body vscode-light'), 'light theme');
    check('A10 自包含（无外链 CDN 样式）', !/<link rel="stylesheet" href="https:/.test(html), 'no external css links');
    check('A12 浅色主题定义代码块背景/边框/前景变量', html.includes('--vscode-textCodeBlock-background:#f2f2f2') && html.includes('--vscode-widget-border:rgba(127, 127, 127, 0.35)') && html.includes('--vscode-editor-foreground:#333333'), 'light code-block vars');

    // dark theme
    __setConfig('markdown-commonmark-preview', 'print.theme', 'dark');
    const { html: htmlDark } = await exportMod.buildExportHtml(doc, {});
    check('A11 主题 dark（vscode-dark + 深色背景变量）', htmlDark.includes('vscode-dark') && htmlDark.includes('--vscode-editor-background:#1e1e1e'), 'dark theme');
    check('A13 深色主题定义代码块背景/前景变量', htmlDark.includes('--vscode-textCodeBlock-background:#2d2d2d') && htmlDark.includes('--vscode-editor-foreground:#d4d4d4'), 'dark code-block vars');
    resetConfig();
  }

  // =====================================================================
  section('B. HTML 导出命令（exportToHtml）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    const mdPath = writeDoc('b-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml');
    const outPath = mdPath.replace(/\.md$/, '.html');
    const exists = fs.existsSync(outPath);
    check('B1 生成 .html 文件', exists, outPath);
    if (exists) {
      const html = fs.readFileSync(outPath, 'utf8');
      check('B2 HTML 默认带 styles', /<style>/.test(html) && html.includes('markdown-body'), 'styles');
      check('B3 HTML 成功提示', /已导出|Exported/.test(lastInfo()), lastInfo());
    }
  }

  // =====================================================================
  section('C. HTML 渲染一致性（mermaid 静态预渲染 + Chrome 打开验证）');
  // =====================================================================
  {
    const outPath = path.join(WORK, 'b-sample.html');
    const htmlFile = fs.readFileSync(outPath, 'utf8');
    const bodyStart = htmlFile.indexOf('<div class="markdown-body">');
    const bodyArea = htmlFile.slice(bodyStart, htmlFile.indexOf('<script', bodyStart));
    check('C0 导出 HTML 文件已含预渲染 SVG（fenced + container 共 2 个）', (bodyArea.match(/class="mermaid-rendered"[\s\S]*?<svg/g) || []).length >= 2, 'static svg count');
    check('C1 导出 HTML 无残留 .mermaid 源码块', !/<pre class="mermaid">/.test(bodyArea) && !/<div class="mermaid">/.test(bodyArea), 'no raw mermaid source');
    // Open in Chrome: the static SVG must be present and no runtime error.
    let dump = run(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--virtual-time-budget=15000', '--dump-dom', 'file://' + outPath]).stdout;
    if (dump.includes('<pre class="mermaid-error">')) {
      dump = run(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--virtual-time-budget=15000', '--dump-dom', 'file://' + outPath]).stdout;
    }
    check('C2 Chrome 打开后 mermaid SVG 仍存在', (dump.match(/class="mermaid-rendered"[\s\S]*?<svg/g) || []).length >= 2, 'svg after chrome open');
    check('C3 无 mermaid 渲染错误（检查渲染出的错误元素）', !dump.includes('<pre class="mermaid-error">'), 'no mermaid-error');
    check('C4 KaTeX 公式已渲染（.katex 类）', dump.includes('katex'), 'katex rendered');
    check('C5 代码高亮（hljs 类）', dump.includes('hljs-keyword') || dump.includes('hljs'), 'hljs');
    check('C6 图片已加载（img src 存在）', /<img[^>]+src="(file|data):/.test(dump), 'img');
    check('C7 任务列表 checkbox 存在', dump.includes('type="checkbox"'), 'task list');
  }

  // =====================================================================
  section('C2. 无 Chrome 时 HTML 导出（mermaid 保留源码 + 内联脚本兜底）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', '/nonexistent/chrome');
    const mdPath = writeDoc('c2-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml');
    const outPath = mdPath.replace(/\.md$/, '.html');
    const html = fs.readFileSync(outPath, 'utf8');
    const bodyStart = html.indexOf('<div class="markdown-body">');
    const bodyArea = html.slice(bodyStart, html.indexOf('<script', bodyStart));
    check('C2-1 无 Chrome 时 mermaid 源码块保留', /<pre class="mermaid">/.test(bodyArea) || /<div class="mermaid">/.test(bodyArea), 'raw source kept');
    check('C2-2 无 Chrome 时内联 mermaid.min.js 兜底（浏览器打开可渲染）', html.includes('__esbuild_esm_mermaid_nm'), 'mermaid runtime inlined');
    check('C2-3 无 Chrome 时 preview.js 内联', html.includes('__commonmarkRender'), 'preview.js inlined');
    resetConfig();
  }

  // =====================================================================
  section('D. PDF 导出（Chrome + 书签大纲）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    const mdPath = writeDoc('d-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToPdf');
    const outPath = mdPath.replace(/\.md$/, '.pdf');
    check('D1 生成 .pdf 文件', fs.existsSync(outPath) && fs.statSync(outPath).size > 0, `size=${fs.existsSync(outPath) ? fs.statSync(outPath).size : 0}`);
    if (fs.existsSync(outPath)) {
      const buf = fs.readFileSync(outPath);
      check('D2 PDF 含书签大纲 /Outlines（标题层级）', buf.includes('/Outlines'), 'outline present');
      check('D3 PDF 含标题书签条目', (buf.toString('latin1').match(/\/Title/g) || []).length >= 3, 'titles count');
      const info = pdfInfo(outPath);
      check('D4 PDF 页面尺寸 A4', /pts \(A4\)/.test(info['Page size'] || ''), `pagesize=${info['Page size']}`);
      const text = pdfText(outPath);
      check('D5 PDF 正文文本存在', text.includes('导出功能验收样例') && text.includes('表格'), 'text');
      check('D6 PDF 渲染了 mermaid 图（SVG 矢量文字在文本中）', text.includes('开始') || text.includes('处理'), 'mermaid text');
      check('D7 PDF 渲染了公式（E = mc）', /E\s*=\s*mc/.test(text), 'math text');
      check('D8 PDF 成功提示', /已导出|Exported/.test(lastInfo()), lastInfo());
    }
  }

  // =====================================================================
  section('E. PDF 关闭标题层级（headingHierarchy=false -> 无书签）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    __setConfig('markdown-commonmark-preview.export', 'headingHierarchy', false);
    const mdPath = writeDoc('e-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToPdf');
    const outPath = mdPath.replace(/\.md$/, '.pdf');
    const buf = fs.readFileSync(outPath);
    check('E1 headingHierarchy=false 时 PDF 无 /Outlines', !buf.includes('/Outlines'), 'no outline');
    resetConfig();
  }

  // =====================================================================
  section('F. PDF 错误路径（Chrome 不可用）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', '/nonexistent/chrome');
    const mdPath = writeDoc('f-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToPdf');
    check('F1 提示 Chrome 未找到（中文）', /Chrome\/Edge/.test(lastError()) || /Chrome\/Edge/.test(state.messages.map(m=>m.msg).join(' ')), lastError());
    check('F2 未生成 PDF 文件', !fs.existsSync(mdPath.replace(/\.md$/, '.pdf')), 'no pdf');
    check('F3 未残留临时文件', fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mcp-pdf-')).length === 0, 'no temp');
    resetConfig();
  }

  // =====================================================================
  section('J. 命令入口与格式选择');
  // =====================================================================
  {
    resetConfig();
    // picker picks first item = HTML
    const mdPath = writeDoc('j-sample.md', '# 仅标题\n\n正文内容');
    setActiveDoc(mdPath, '# 仅标题\n\n正文内容');
    await stub.commands.executeCommand('markdown-commonmark-preview.export');
    check('J1 export（picker->HTML 第一项）生成 html', fs.existsSync(mdPath.replace(/\.md$/, '.html')), 'html created');
    // preview floating button: export with an explicit source URI while the
    // active editor is an unrelated document (picker picks HTML first).
    const mdPath3 = writeDoc('j3-sample.md', '# 预览导出\n\n内容');
    const otherPath = writeDoc('j3-other.txt', 'not markdown');
    setActiveDoc(otherPath, 'not markdown');
    await stub.commands.executeCommand('markdown-commonmark-preview.export', stub.Uri.file(mdPath3));
    check('J3 预览按钮传 URI 导出 HTML（活动编辑器非目标文档也可导出）', fs.existsSync(mdPath3.replace(/\.md$/, '.html')), 'html created');
    resetConfig();
  }

  // =====================================================================
  section('K. 无有效 Markdown 文件时的防护');
  // =====================================================================
  {
    resetConfig();
    stub.window.__setActiveEditor(undefined);
    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml');
    check('K1 无活动编辑器时提示无有效 Markdown 文件', /没有有效|No valid/.test(lastError()), lastError());
  }

  // =====================================================================
  section('M. 预览标题栏导出按钮（自定义编辑器，无活动文本编辑器）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    const mdPath = writeDoc('m-sample.md', sampleMd);
    const doc = makeTextDocument(mdPath, sampleMd);
    stub.workspace.textDocuments.push(doc);
    // The preview tab is opened with a unique query (commonmarkCustomEditors
    // appends `commonmarkPreview=<ts>`), so the editor/title commands receive
    // that query-suffixed URI while the preview (not a text editor) is focused.
    const previewUri = stub.Uri.file(mdPath).with({ query: 'commonmarkPreview=12345' });
    stub.window.__setActiveEditor(undefined);
    // The active tab is the preview custom-editor tab (TabInputCustom-like).
    stub.window.__setActiveTab({ uri: previewUri, viewType: 'markdown-commonmark-preview.preview' });

    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml', previewUri);
    check('M1 标题栏导出 HTML：使用传入的预览 URI（去除查询后缀）', fs.existsSync(mdPath.replace(/\.md$/, '.html')), 'html created');
    check('M2 无“没有有效的 Markdown 文件”提示', !/没有有效|No valid/.test(lastError()), lastError() || 'no error');
    fs.rmSync(mdPath.replace(/\.md$/, '.html'), { force: true });

    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToPdf');
    check('M3 无 URI 时按活动标签页导出 PDF（预览聚焦场景）', fs.existsSync(mdPath.replace(/\.md$/, '.pdf')), 'pdf created');
    check('M4 无“没有有效的 Markdown 文件”提示', !/没有有效|No valid/.test(lastError()), lastError() || 'no error');
    fs.rmSync(mdPath.replace(/\.md$/, '.pdf'), { force: true });

    stub.window.__setActiveTab(undefined);
    clearMessages();
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml');
    check('M5 无编辑器且无标签页时仍提示无有效 Markdown 文件', /没有有效|No valid/.test(lastError()), lastError());
    stub.window.__setActiveEditor(undefined);
    stub.workspace.textDocuments.pop();
    resetConfig();
  }

  // =====================================================================
  section('L. 传统 printToHtml 回归');
  // =====================================================================
  {
    // printToHtml is fire-and-forget (async write); poll for the output file.
    async function waitForFile(p, timeoutMs = 10000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(p)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return fs.existsSync(p);
    }
    resetConfig();
    __setConfig('markdown-commonmark-preview', 'print.imgToBase64', true);
    __setConfig('markdown-commonmark-preview', 'print.absoluteImgPath', true);
    const mdPath = writeDoc('l-sample.md', sampleMd);
    setActiveDoc(mdPath, sampleMd);
    await stub.commands.executeCommand('markdown-commonmark-preview.printToHtml');
    const outPath = mdPath.replace(/\.md$/, '.html');
    const exists = await waitForFile(outPath);
    check('L1 printToHtml 仍生成 HTML', exists, outPath);
    if (exists) {
      const { decodeHTML } = require('entities');
      const html = decodeHTML(fs.readFileSync(outPath, 'utf8'));
      check('L2 标题保留', html.includes('<title>导出功能验收样例</title>'), 'title');
      check('L3 图片 base64 内联', html.includes('data:image/png;base64,'), 'base64 img');
      check('L4 .md 链接转 .html', html.includes('other.html'), 'links');
      check('L6 printToHtml 包含主题变量（代码块样式可用）', html.includes('--vscode-textCodeBlock-background:#f2f2f2'), 'theme vars');
    }
    // pureHtml mode
    __setConfig('markdown-commonmark-preview', 'print.pureHtml', true);
    const mdPath2 = writeDoc('l2-sample.md', sampleMd);
    setActiveDoc(mdPath2, sampleMd);
    await stub.commands.executeCommand('markdown-commonmark-preview.printToHtml');
    const outPath2 = mdPath2.replace(/\.md$/, '.html');
    await waitForFile(outPath2);
    const html2 = fs.readFileSync(outPath2, 'utf8');
    check('L5 printToHtml pureHtml 模式（无 DOCTYPE 包裹）', !html2.startsWith('<!DOCTYPE'), 'pure html');
    resetConfig();
  }

  // =====================================================================
  section('N. 空文档 / 无标题文档');
  // =====================================================================
  {
    resetConfig();
    const mdPath = writeDoc('n-empty.md', '');
    setActiveDoc(mdPath, '');
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToHtml');
    const html = fs.readFileSync(mdPath.replace(/\.md$/, '.html'), 'utf8');
    check('N1 空文档导出 HTML 不报错', html.includes('markdown-body'), 'empty ok');
    resetConfig();
  }

  // =====================================================================
  section('O. 中文路径（含空格）');
  // =====================================================================
  {
    resetConfig();
    __setConfig('markdown-commonmark-preview.export', 'chromePath', CHROME);
    const dir = fs.mkdtempSync(path.join(WORK, '中文 目录-'));
    const mdPath = path.join(dir, '测试 文档.md');
    fs.writeFileSync(mdPath, '# 中文标题\n\n正文。', 'utf8');
    setActiveDoc(mdPath, '# 中文标题\n\n正文。');
    await stub.commands.executeCommand('markdown-commonmark-preview.exportToPdf');
    check('O1 中文路径 PDF 导出成功', fs.existsSync(mdPath.replace(/\.md$/, '.pdf')), 'pdf');
    resetConfig();
  }

  // =====================================================================
  // summary
  // =====================================================================
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n========== SUMMARY: ${pass} passed, ${fail} failed, ${results.length} total ==========`);
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ results, pass, fail, work: WORK }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('RUNNER ERROR:', e);
  process.exit(2);
});
