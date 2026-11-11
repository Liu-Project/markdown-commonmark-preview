// Export feature for Markdown CommonMark Preview.
//
// Provides a unified "Markdown -> self-contained HTML" pipeline that is shared
// by the two export formats (HTML / PDF), so the exported result is always
// consistent with the preview:
//
//  - HTML : the self-contained HTML document is written as-is (styles included
//           by default).
//  - PDF  : the same HTML is printed with headless Chrome
//           (`--generate-pdf-document-outline` produces a heading outline).
//
// Based on Markdown All in One (MIT License, Copyright (c) 2017 张宇).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { spawn } from "child_process";
import { commands, ExtensionContext, TextDocument, Uri, window, workspace } from 'vscode';
import { decodeHTML, encodeHTML } from 'entities';
import { localize } from './nls';
import { mdEngine } from "./markdownEngine";
import { isMdDocument } from "./util/generic";
import { renderMarkdownBody, COMMON_CONTENT_CSS } from "./commonmarkCustomEditors";

let thisContext: ExtensionContext;

//#region activation

export function activate(context: ExtensionContext) {
    thisContext = context;
    context.subscriptions.push(
        commands.registerCommand('markdown-commonmark-preview.export', (uri?: Uri) => exportWithPicker(uri)),
        commands.registerCommand('markdown-commonmark-preview.exportToHtml', () => exportDocument('html')),
        commands.registerCommand('markdown-commonmark-preview.exportToPdf', () => exportDocument('pdf'))
    );
}

export function deactivate() { }

//#endregion

//#region shared helpers (moved from print.ts, behaviour preserved)

/**
 * Determines the document title:
 *  1. an HTML comment `<!-- title: Document Title -->` at the very first line;
 *  2. otherwise the first ATX heading (`# ...`).
 */
export function extractDocumentTitle(doc: TextDocument): string | undefined {
    const firstLineText = doc.lineAt(0).text;
    // The lazy quantifier and `trim()` can avoid mistakenly capturing cases like:
    // <!-- title:-->-->
    // <!-- title: --> -->
    let m = /^<!-- title:(.*?)-->/.exec(firstLineText);
    let title: string | undefined = m === null ? undefined : m[1].trim();

    // Empty string is also falsy.
    if (!title) {
        // Editors treat `\r\n`, `\n`, and `\r` as EOL.
        // Since we don't care about line numbers, a simple alternation is enough and slightly faster.
        title = doc.getText().split(/\n|\r/g).find(lineText => lineText.startsWith('#') && /^#{1,6} /.test(lineText));
        if (title) {
            title = title.replace(/<!--(.*?)-->/g, '');
            title = title.trim().replace(/^#+/, '').replace(/#+$/, '').trim();
        }
    }
    return title;
}

/**
 * Rewrites `<img src>` in the rendered body:
 *  - base64-inlines local images when `forceBase64` is set;
 *  - otherwise converts relative paths to absolute `file:///` paths
 *    (controlled by `print.absoluteImgPath` / `print.imgToBase64`).
 */
export function processDocumentImages(doc: TextDocument, body: string, forceBase64: boolean = false): string {
    const config = workspace.getConfiguration('markdown-commonmark-preview', doc.uri);
    const configToBase64 = forceBase64 || config.get<boolean>('print.imgToBase64');
    const configAbsPath = config.get<boolean>('print.absoluteImgPath');
    const imgTagRegex = /(<img[^>]+src=")([^"]+)("[^>]*>)/g;  // Match '<img...src="..."...>'

    let result = body;
    if (configToBase64) {
        result = result.replace(imgTagRegex, function (_, p1, p2, p3) {
            if (p2.startsWith('http') || p2.startsWith('data:')) {
                return _;
            }

            const imgSrc = relToAbsPath(doc.uri, p2);
            try {
                let imgExt = path.extname(imgSrc).slice(1);
                if (imgExt === "jpg") {
                    imgExt = "jpeg";
                } else if (imgExt === "svg") {
                    imgExt += "+xml";
                }
                const file = fs.readFileSync(imgSrc.replace(/%20/g, '\ ')).toString('base64');
                return `${p1}data:image/${imgExt};base64,${file}${p3}`;
            } catch (e) {
                window.showWarningMessage(localize("ui.general.messageUnableToReadFile", imgSrc) + ` ${localize("ui.exporting.messageRevertingToImagePaths")} (${doc.fileName})`);
            }

            if (configAbsPath) {
                return `${p1}file:///${imgSrc}${p3}`;
            } else {
                return _;
            }
        });
    } else if (configAbsPath) {
        result = result.replace(imgTagRegex, function (_, p1, p2, p3) {
            if (p2.startsWith('http') || p2.startsWith('data:')) {
                return _;
            }

            const imgSrc = relToAbsPath(doc.uri, p2);
            // Absolute paths need `file:///` but relative paths don't
            return `${p1}file:///${imgSrc}${p3}`;
        });
    }
    return result;
}

/** Converts `.md` links to `.html` by default. */
export function convertMdLinksToHtml(body: string): string {
    const hrefRegex = /(<a[^>]+href=")([^"]+)("[^>]*>)/g;  // Match '<a...href="..."...>'
    return body.replace(hrefRegex, function (_, g1, g2, g3) {
        if ((g2.endsWith('.md') || g2.includes('.md#')) && !(g2.includes('github.com') && g2.includes('blob'))) {
            return `${g1}${g2.replace(/\.md$/, '.html').replace(/\.md#/, '.html#')}${g3}`;
        } else {
            return _;
        }
    });
}

export function hasMathEnv(text: string) {
    // I'm lazy
    return text.includes('$');
}

export function wrapWithStyleTag(src: string) {
    if (src.startsWith('http')) {
        return `<link rel="stylesheet" href="${src}">`;
    } else {
        return `<style>\n${readCss(src)}\n</style>`;
    }
}

export function readCss(fileName: string) {
    try {
        return fs.readFileSync(fileName).toString();
    } catch (error) {
        // https://nodejs.org/docs/latest-v12.x/api/errors.html#errors_class_systemerror
        window.showWarningMessage(localize("ui.exporting.messageCustomCssNotFound", (error as NodeJS.ErrnoException).path));
        return '';
    }
}

export function getCustomStyleSheets(resource: Uri): string[] {
    const styles = workspace.getConfiguration('markdown', resource)['styles'];
    if (styles && Array.isArray(styles) && styles.length > 0) {
        const root = workspace.getWorkspaceFolder(resource);
        return styles.map(s => {
            if (!s || s.startsWith('http') || path.isAbsolute(s)) {
                return s;
            }

            if (root) {
                return path.join(root.uri.fsPath, s);
            } else {
                // Otherwise look relative to the markdown file
                return path.join(path.dirname(resource.fsPath), s);
            }
        });
    }
    return [];
}

export function relToAbsPath(resource: Uri, href: string): string {
    if (!href || href.startsWith('http') || path.isAbsolute(href)) {
        return href;
    }

    // Otherwise look relative to the markdown file
    return path.join(path.dirname(resource.fsPath), href);
}

export function getPreviewSettingStyles(): string {
    const previewSettings = workspace.getConfiguration('markdown')['preview'];
    if (!previewSettings) {
        return '';
    }
    const { fontFamily, fontSize, lineHeight } = previewSettings;
    return `<style>
            body {
                ${fontFamily ? `font-family: ${fontFamily};` : ''}
                ${+fontSize > 0 ? `font-size: ${fontSize}px;` : ''}
                ${+lineHeight > 0 ? `line-height: ${lineHeight};` : ''}
            }
        </style>`;
}

//#endregion

//#region preview styles / scripts (inlined, self-contained)

/** Inlines local `url(...)` assets (fonts/images) referenced by a CSS file as data URIs. */
function inlineCssAssets(cssText: string, cssFilePath: string): string {
    const baseDir = path.dirname(cssFilePath);
    return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, _quote: string, urlPath: string) => {
        const trimmed = (urlPath || '').trim();
        // Never touch absolute/data URLs; keep `#` fragment references as-is.
        if (!trimmed || /^(data:|https?:|\/\/|#)/i.test(trimmed)) {
            return match;
        }
        const clean = trimmed.split(/[?#]/)[0];
        if (!clean) {
            return match;
        }
        const full = path.resolve(baseDir, decodeURIComponent(clean));
        try {
            const stat = fs.statSync(full);
            if (!stat.isFile()) {
                return match;
            }
            // Only inline formats modern browsers actually need (avoids bloating
            // the export with legacy woff/ttf duplicates).
            const mime = mimeForFile(full);
            if (!mime) {
                return match;
            }
            const data = fs.readFileSync(full);
            return `url(data:${mime};base64,${data.toString('base64')})`;
        } catch {
            return match;
        }
    });
}

function mimeForFile(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.woff2': return 'font/woff2';
        case '.svg': return 'image/svg+xml';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.ico': return 'image/x-icon';
        default: return undefined;
    }
}

/**
 * Inlines every contributed `markdown.previewStyles` into one `<style>` block.
 * When `inlineAssets` is false, `url(...)` assets (e.g. KaTeX fonts) are left
 * untouched — this keeps documents without math small (the font files are only
 * needed when `.katex` elements exist).
 */
export async function getPreviewExtensionStyles(inlineAssets: boolean = true) {
    var result = "<style>\n"
    for (const contribute of mdEngine.contributionsProvider.contributions) {
        if (!contribute.previewStyles || !contribute.previewStyles.length) {
            continue;
        }
        result += `/* From extension ${contribute.extensionId} */\n`;
        for (const styleFile of contribute.previewStyles) {
            try {
                const raw = await fs.promises.readFile(styleFile.fsPath, { encoding: "utf8" });
                result += inlineAssets ? inlineCssAssets(raw, styleFile.fsPath) : raw;
            } catch (error) {
                result += "/* Error */";
            }
            result += "\n";
        }
    }
    result += "</style>";
    return result;
}

/**
 * Inlines every contributed `markdown.previewScripts` into `<script>` tags.
 * The (large) mermaid runtime is skipped when `includeMermaid` is false to keep
 * exports of documents without diagrams small.
 */
export async function getPreviewExtensionScripts(includeMermaid: boolean = true) {
    var result = "";
    for (const contribute of mdEngine.contributionsProvider.contributions) {
        if (!contribute.previewScripts || !contribute.previewScripts.length) {
            continue;
        }
        for (const scriptFile of contribute.previewScripts) {
            if (!includeMermaid && path.basename(scriptFile.fsPath) === 'mermaid.min.js') {
                continue;
            }
            result += `<script type="text/javascript">\n/* From extension ${contribute.extensionId} */\n`;
            try {
                result += await fs.promises.readFile(scriptFile.fsPath, { encoding: "utf8" });
            } catch (error) {
                result += "/* Error */";
            }
            result += `\n</script>\n`;
        }
    }
    return result;
}

/**
 * Styles that reproduce the custom-editor preview exactly:
 *  - KaTeX (fonts inlined so the export works offline)
 *  - vscode-highlight.css (theme-aware code highlighting, like the preview)
 *  - vscode-markdown.css (VS Code markdown base styles, like the preview)
 *  - COMMON_CONTENT_CSS (the preview's content rendering rules: pre-wrap
 *    paragraphs, mermaid, HTML-tag styling, ...)
 *
 * Deliberately does NOT include the `markdown.previewStyles` contributions
 * (commonmark-style.css / checkbox.css / hljs-github.min.css): those only apply
 * to the VS Code built-in preview, and including them made the export look
 * like the built-in preview instead of our custom-editor preview.
 */
async function getPreviewConsistentStyles(): Promise<string> {
    let css = '';
    const katexPath = thisContext.asAbsolutePath('media/katex/katex.min.css');
    try {
        const katexCss = await fs.promises.readFile(katexPath, 'utf8');
        css += `<style>\n${inlineCssAssets(katexCss, katexPath)}\n</style>`;
    } catch { /* ignore */ }
    css += wrapWithStyleTag(thisContext.asAbsolutePath('media/vscode-highlight.css'));
    css += wrapWithStyleTag(thisContext.asAbsolutePath('media/vscode-markdown.css'));
    css += `<style>\n${COMMON_CONTENT_CSS}\n</style>`;
    css += getPreviewSettingStyles();
    return css;
}

function getPageCss(pageSize?: string, pageMargin?: string): string {
    const size = (pageSize && pageSize.trim()) || 'A4';
    const margin = (pageMargin && pageMargin.trim()) || '20mm';
    return `@media print { @page { size: ${size}; margin: ${margin}; } }`;
}

/** Styles used by the legacy `printToHtml` command (kept behaviour-identical). */
export function getPrintStyles(uri: Uri, hasMathEnvFlag: boolean, includeVscodeStyles: boolean) {
    const katexCss = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex/dist/katex.min.css">';
    const markdownCss = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/Microsoft/vscode/extensions/markdown-language-features/media/markdown.css">';
    const highlightCss = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/Microsoft/vscode/extensions/markdown-language-features/media/highlight.css">';
    const copyTeXCss = '<link href="https://cdn.jsdelivr.net/npm/katex-copytex@latest/dist/katex-copytex.min.css" rel="stylesheet" type="text/css">';

    const baseCssPaths = [
        'media/checkbox.css',
        "media/github-alerts/github-colors-light.css",
        "media/github-alerts/github-colors-dark-media.css",
        'media/github-alerts/github-base.css'
    ].map(s => thisContext.asAbsolutePath(s));
    const customCssPaths = getCustomStyleSheets(uri);

    return `${hasMathEnvFlag ? katexCss + '\n' + copyTeXCss : ''}
        ${includeVscodeStyles
            ? markdownCss + '\n' + highlightCss + '\n' + getPreviewSettingStyles()
            : ''}
        ${baseCssPaths.map(cssSrc => wrapWithStyleTag(cssSrc)).join('\n')}
        ${customCssPaths.map(cssSrc => wrapWithStyleTag(cssSrc)).join('\n')}`;
}

//#endregion

//#region unified HTML pipeline

export interface BuildExportHtmlOptions {
    /** Document title (defaults to auto-detection). */
    title?: string;
    /** Export theme: 'light' or 'dark' (defaults to `print.theme`). */
    theme?: 'light' | 'dark';
    /** PDF page size, e.g. "A4" (only used when generating PDF). */
    pdfPageSize?: string;
    /** PDF page margin, e.g. "20mm" (only used when generating PDF). */
    pdfPageMargin?: string;
}

export interface ExportHtmlResult {
    /** The full self-contained HTML document. */
    html: string;
    /** The processed body fragment (images/links handled). */
    body: string;
    title: string | undefined;
}

/** Renders + post-processes the markdown body (images, links). */
export async function renderBody(doc: TextDocument): Promise<string> {
    // Use the exact same renderer as the custom-editor preview
    // (commonmarkCustomEditors.renderMarkdownBody): protectIndent keeps
    // indented continuation lines, texmath handles KaTeX and no
    // github-alerts transform is applied — so the exported document matches
    // the preview pixel-for-pixel instead of looking like the built-in
    // markdown-it preview.
    let body: string = renderMarkdownBody(doc.getText());
    body = processDocumentImages(doc, body);
    body = convertMdLinksToHtml(body);
    return body;
}

/**
 * Builds a fully self-contained HTML document from a markdown document:
 * all CSS/JS (katex, highlight.js, mermaid, commonmark styles) are inlined so
 * the file renders offline exactly like the preview.
 */
export async function buildExportHtml(doc: TextDocument, options: BuildExportHtmlOptions = {}): Promise<ExportHtmlResult> {
    const title = options.title !== undefined ? options.title : extractDocumentTitle(doc);
    let body = await renderBody(doc);
    const hasMath = hasMathEnv(doc.getText());
    const hasMermaid = bodyHasMermaid(body);

    // Pre-render every mermaid diagram to an inline SVG when Chrome is
    // available, so the exported HTML shows the rendered diagram immediately
    // (no JS needed at open time). When Chrome is missing (or a diagram fails),
    // the original `.mermaid` source stays and is rendered at runtime by the
    // inlined preview scripts (kept as a fallback below).
    let mermaidNeedsRuntime = hasMermaid;
    if (hasMermaid) {
        const chromePath = await findChrome();
        if (chromePath) {
            const svgs = await renderMermaidSvgs(body, chromePath);
            body = replaceMermaidWithSvg(body, svgs);
            mermaidNeedsRuntime = bodyHasMermaid(body);
        }
    }

    const themeKind = options.theme ?? workspace.getConfiguration('markdown-commonmark-preview', doc.uri).get<string>('print.theme', 'light');
    const isDark = themeKind === 'dark';
    const themeClass = isDark ? 'vscode-dark' : 'vscode-light';

    const extensionScripts = await getPreviewExtensionScripts(mermaidNeedsRuntime);
    const previewStyles = await getPreviewConsistentStyles();
    const pageCss = (options.pdfPageSize || options.pdfPageMargin) ? getPageCss(options.pdfPageSize, options.pdfPageMargin) : '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title ? encodeHTML(title) : ''}</title>
<style>
html, body { margin: 0; padding: 0; }
body { background-color: ${isDark ? '#1e1e1e' : '#ffffff'}; }
.mermaid-rendered { margin: 0.8em 0; text-align: center; }
.mermaid-rendered svg { max-width: 100%; height: auto; }
${pageCss}
</style>
${previewStyles}
</head>
<body class="vscode-body ${themeClass}">
<div class="markdown-body">
${body}
</div>
${extensionScripts}
</body>
</html>`;

    return { html, body, title };
}

//#endregion

//#region executable discovery

function findOnPath(name: string): string | undefined {
    const pathVar = process.env.PATH || '';
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of pathVar.split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const ext of exts) {
            const full = path.join(dir, name + ext);
            try {
                if (fs.existsSync(full) && fs.statSync(full).isFile() && (process.platform !== 'win32' || ext !== '')) {
                    // On POSIX require the executable bit.
                    if (process.platform === 'win32' || (fs.statSync(full).mode & 0o111) !== 0) {
                        return full;
                    }
                }
            } catch {
                // ignore
            }
        }
    }
    return undefined;
}

const CHROME_NAMES = [
    'google-chrome', 'google-chrome-stable', 'google-chrome-beta', 'google-chrome-dev',
    'chromium', 'chromium-browser', 'chrome', 'msedge', 'microsoft-edge'
];

const COMMON_CHROME_PATHS = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Resolves the Chrome/Edge executable, honouring `export.chromePath`. */
export async function findChrome(): Promise<string | undefined> {
    const configured = workspace.getConfiguration('markdown-commonmark-preview.export').get<string>('chromePath', '');
    if (configured && configured.trim()) {
        const trimmed = configured.trim();
        if (fs.existsSync(trimmed)) {
            return trimmed;
        }
        // Configured but missing -> let the caller show a precise error.
        return undefined;
    }
    for (const name of CHROME_NAMES) {
        const found = findOnPath(name);
        if (found) {
            return found;
        }
    }
    for (const p of COMMON_CHROME_PATHS) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    // Windows default install locations.
    if (process.platform === 'win32') {
        const roots = [
            process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']
        ];
        const rels = [
            'Google/Chrome/Application/chrome.exe',
            'Microsoft/Edge/Application/msedge.exe',
            'Google/Chrome/Application/chrome.exe',
        ];
        for (const root of roots) {
            if (!root) {
                continue;
            }
            for (const rel of rels) {
                const full = path.join(root, rel);
                if (fs.existsSync(full)) {
                    return full;
                }
            }
        }
    }
    return undefined;
}

//#endregion

//#region process runner

interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, { windowsHide: true });
        } catch (err) {
            resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false });
            return;
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        if (child.stdout) {
            child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        }
        if (child.stderr) {
            child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut });
        });
    });
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let idx = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (idx < items.length) {
            const item = items[idx++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

//#endregion

//#region PDF export

async function exportToPdf(doc: TextDocument, outPath: string): Promise<void> {
    const chromePath = await findChrome();
    if (!chromePath) {
        window.showErrorMessage(localize('ui.exporting.messageChromeNotFound'));
        return;
    }

    const config = workspace.getConfiguration('markdown-commonmark-preview.export', doc.uri);
    const headingHierarchy = config.get<boolean>('headingHierarchy', true);
    const pageSize = config.get<string>('pdfPageSize', 'A4');
    const pageMargin = config.get<string>('pdfMargin', '20mm');

    const { html } = await buildExportHtml(doc, { pdfPageSize: pageSize, pdfPageMargin: pageMargin });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pdf-'));
    const tmpHtml = path.join(tmpDir, 'export.html');
    fs.writeFileSync(tmpHtml, html, 'utf8');
    try {
        const args = [
            '--headless',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            `--user-data-dir=${path.join(tmpDir, 'profile')}`,
            '--virtual-time-budget=8000',
            `--print-to-pdf=${outPath}`,
            '--no-pdf-header-footer'
        ];
        if (headingHierarchy) {
            args.push('--generate-pdf-document-outline');
        }
        args.push(pathToFileURL(tmpHtml).href);

        const result = await runProcess(chromePath, args, 120000);
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
            const reason = result.stderr && result.stderr.trim() ? result.stderr.trim() : String(result.code);
            throw new Error(localize('ui.exporting.messagePdfFailed', reason));
        }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

//#endregion

//#region mermaid pre-rendering

const MERMAID_BLOCK_REGEX = /<pre class="mermaid"([^>]*)>([\s\S]*?)<\/pre>|<div class="mermaid"([^>]*)>([\s\S]*?)<\/div>/g;

/** Whether the rendered body contains mermaid diagrams. */
function bodyHasMermaid(body: string): boolean {
    const regex = new RegExp(MERMAID_BLOCK_REGEX.source, MERMAID_BLOCK_REGEX.flags);
    return regex.test(body);
}

/**
 * Phase A: builds a page with every `.mermaid` source and uses headless Chrome
 * (`--dump-dom`) to render them with mermaid. Each rendered SVG is stored in a
 * `<textarea>` so it can be extracted reliably (SVGs may contain nested
 * `<div>`s inside `<foreignObject>`, which a plain regex cannot balance).
 */
async function renderMermaidSvgs(body: string, chromePath: string): Promise<(string | null)[]> {
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    const regex = new RegExp(MERMAID_BLOCK_REGEX.source, MERMAID_BLOCK_REGEX.flags);
    while ((m = regex.exec(body)) !== null) {
        blocks.push((m[2] || m[4] || '').trim());
    }
    if (blocks.length === 0) {
        return [];
    }

    const mermaidJs = thisContext.asAbsolutePath('media/mermaid.min.js');
    const diagrams = blocks
        .map((source, i) => `<div class="mermaid" id="d${i}">${source}</div>`)
        .join('\n');
    const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;}</style></head>
<body>
<div id="out">
${diagrams}
</div>
<script src="${pathToFileURL(mermaidJs).href}"></script>
<script>
(function () {
  mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose' });
  var nodes = Array.prototype.slice.call(document.querySelectorAll('.mermaid'));
  var done = 0;
  function finish() { done++; if (done >= nodes.length) { document.body.setAttribute('data-rendered', 'true'); } }
  nodes.forEach(function (node, i) {
    var source = (node.textContent || '').trim();
    mermaid.parse(source)
      .then(function () { return mermaid.render('mmd' + i, source); })
      .then(function (res) {
        var ta = document.createElement('textarea');
        ta.id = 'd' + i;
        // NOTE: assigning to .value does NOT survive --dump-dom serialization;
        // the SVG must be added as a real text node.
        ta.appendChild(document.createTextNode(res.svg));
        node.innerHTML = '';
        node.appendChild(ta);
      })
      .catch(function (e) {
        var pre = document.createElement('pre');
        pre.className = 'merr';
        pre.textContent = (e && e.message) ? e.message : String(e);
        node.innerHTML = '';
        node.appendChild(pre);
      })
      .finally(finish);
  });
})();
</script>
</body></html>`;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mm-'));
    const pagePath = path.join(tmpDir, 'capture.html');
    fs.writeFileSync(pagePath, page, 'utf8');
    try {
        const result = await runProcess(chromePath, [
            '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
            `--user-data-dir=${path.join(tmpDir, 'profile')}`,
            '--virtual-time-budget=15000',
            '--dump-dom',
            pathToFileURL(pagePath).href
        ], 60000);
        const dump = result.stdout;
        const out: (string | null)[] = blocks.map(() => null);
        for (let i = 0; i < blocks.length; i++) {
            const taRe = new RegExp(`<textarea id="d${i}">([\\s\\S]*?)</textarea>`);
            const tm = taRe.exec(dump);
            if (tm) {
                out[i] = decodeHTML(tm[1]);
            }
        }
        return out;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Replaces every `.mermaid` block with its pre-rendered inline SVG (keeps the original on failure). */
function replaceMermaidWithSvg(body: string, svgs: (string | null)[]): string {
    let idx = 0;
    return body.replace(MERMAID_BLOCK_REGEX, (match) => {
        const svg = svgs[idx++];
        if (svg) {
            return `<div class="mermaid-rendered">${svg}</div>`;
        }
        return match;
    });
}

//#endregion

//#region command entry points

type ExportFormat = 'html' | 'pdf';

function computeOutPath(doc: TextDocument, format: ExportFormat): string {
    const ext = format === 'html' ? 'html' : 'pdf';
    let outPath = doc.fileName.replace(/\.\w+?$/, `.${ext}`);
    outPath = outPath.replace(/^([cdefghij]):\\/, function (_, p1: string) {
        return `${p1.toUpperCase()}:\\`; // Capitalize drive letter
    });
    if (!outPath.endsWith(`.${ext}`)) {
        outPath += `.${ext}`;
    }
    return outPath;
}

async function exportDocument(format: ExportFormat, uri?: Uri): Promise<void> {
    if (!uri) {
        const editor = window.activeTextEditor;
        if (!editor || !isMdDocument(editor?.document)) {
            window.showErrorMessage(localize("ui.general.messageNoValidMarkdownFile"));
            return;
        }
        uri = editor.document.uri;
    }

    const doc = await workspace.openTextDocument(uri);
    if (doc.isDirty || doc.isUntitled) {
        await doc.save();
    }

    const statusBarMessage = window.setStatusBarMessage("$(sync~spin) " + localize("ui.exporting.messageExportingInProgress", path.basename(doc.fileName), format.toUpperCase()));
    const outPath = computeOutPath(doc, format);

    try {
        if (format === 'html') {
            const { html } = await buildExportHtml(doc, {});
            fs.writeFileSync(outPath, html, 'utf8');
        } else {
            await exportToPdf(doc, outPath);
        }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
            window.showInformationMessage(localize('ui.exporting.messageExportSuccess', outPath));
        } else {
            window.showErrorMessage(localize('ui.exporting.messageExportFailed', localize('ui.exporting.messageEmptyOutput')));
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        window.showErrorMessage(localize('ui.exporting.messageExportFailed', msg));
    } finally {
        // Hold the message for extra 500ms, in case the operation finished very fast.
        setTimeout(() => statusBarMessage.dispose(), 500);
    }
}

async function exportWithPicker(uri?: Uri): Promise<void> {
    const pick = await window.showQuickPick(
        [
            { label: localize('ui.exporting.format.html'), description: localize('ui.exporting.format.htmlDesc') },
            { label: localize('ui.exporting.format.pdf'), description: localize('ui.exporting.format.pdfDesc') }
        ],
        { placeHolder: localize('ui.exporting.pickFormat') }
    );
    if (!pick) {
        return;
    }
    let format: ExportFormat;
    if (pick.label === localize('ui.exporting.format.html')) {
        format = 'html';
    } else {
        format = 'pdf';
    }
    return exportDocument(format, uri);
}

//#endregion
