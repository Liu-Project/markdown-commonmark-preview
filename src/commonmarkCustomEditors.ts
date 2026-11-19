// This extension's own custom-editor implementation (self-written).
//
// The scroll-sync machinery embedded in the webview (functions q/G/at/me/R/Me/
// isVisible and the lineEls model) is a verbatim port of VS Code's built-in
// Markdown preview (extensions/markdown-language-features/media/index.js).
// VS Code is licensed under the MIT License, Copyright (c) Microsoft Corporation.
// See THIRD_PARTY_NOTICES.md.

import * as vscode from "vscode";
import * as path from "path";

const MarkdownIt = require("markdown-it");
const taskLists = require("markdown-it-task-lists");
const texmath = require("markdown-it-texmath");
const katex = require("katex");
const hljs = require("highlight.js");
const { installHtmlTagStyling } = require("./htmlTagStyler");
const { extendMarkdownItWithMermaid } = require("./mermaid-markdown-it");
import {
  getPreviewColorScheme,
  isEffectiveDark,
  renderPreviewColorSchemeCss,
  togglePreviewColorScheme
} from "./previewColorSchemes";
import type { PreviewColorScheme } from "./previewColorSchemes";
import { localize } from "./nls";

/**
 * Markdown-compatible renderer (CommonMark).
 *
 * Real-world Markdown exports render indented "1. xxx" lines that directly
 * follow a paragraph as *plain paragraph text* (kept in the same <p>, line
 * breaks + indentation preserved via white-space: pre-wrap), NOT as an <ol>.
 * Only un-indented lists separated by blank lines become <ol>.
 *
 * markdown-it already matches this behaviour (CommonMark lazy continuation),
 * but it strips the leading spaces of continuation lines. To keep the
 * indentation we replace those leading spaces with non-breaking spaces before
 * rendering, so they survive parsing and display exactly like the reference.
 */
function protectIndent(text: string): string {
  return text.split("\n").map((line, i) => {
    if (i === 0) return line;
    const m = line.match(/^ */);
    if (m && m[0].length > 0) {
      return "\u00A0".repeat(m[0].length) + line.slice(m[0].length);
    }
    return line;
  }).join("\n");
}

function buildMd() {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false, highlight: (str: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; } catch (e) {}
    }
    return "";
  }});
  md.use(taskLists, { enabled: true });
  md.use(texmath, { engine: katex, delimiters: "dollars", katexOptions: { throwOnError: false } });

  // Attach `data-line` (source line number) to every block-level element so the
  // preview can scroll in sync with the editor (same mechanism as VS Code's
  // built-in Markdown preview).
  const blockRules = [
    "heading_open", "paragraph_open", "bullet_list_open", "ordered_list_open",
    "blockquote_open", "table_open", "hr", "fence", "code_block", "html_block",
    "list_item_open"
  ];
  for (const rule of blockRules) {
    const defaultRenderer = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens: any[], idx: number, options: any, env: any, self: any) => {
      const token = tokens[idx];
      const map = token.map;
      const line = (map && typeof map[0] === "number") ? map[0] : undefined;
      if (line !== undefined && token.attrGet("data-line") === null) {
        token.attrSet("data-line", String(line));
      }
      return defaultRenderer ? defaultRenderer(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
  }

  // Typora-style: render custom/unknown XML tags as grey text instead of
  // letting the browser swallow them. Must run AFTER the data-line rules so
  // block-level html still carries the source-line attribute.
  installHtmlTagStyling(md);

  // Mermaid diagram support (VS Code built-in mermaid-markdown-features parity).
  extendMarkdownItWithMermaid(md);

  return md;
}

/**
 * Renders the markdown body. When `resolveImage` is provided, every `<img>`
 * `src` (both markdown `![](...)` and raw HTML `<img>`) is rewritten through
 * it so relative file paths become absolute webview URIs the webview can load.
 */
export function renderMarkdownBody(text: string, resolveImage?: (src: string) => string): string {
  const body = buildMd().render(protectIndent(text));
  if (!resolveImage) {
    return body;
  }
  return body.replace(/(<img[^>]+src=")([^"]+)("[^>]*>)/g, (_, p1: string, p2: string, p3: string) => {
    return `${p1}${resolveImage(p2)}${p3}`;
  });
}

/**
 * Content-rendering CSS shared by the custom-editor preview and the export
 * pipeline. The preview-specific layout (html/body/#root, scroll behaviour,
 * the trailing blank space) is NOT included so the exported HTML keeps a
 * normal scrollable page while rendering the markdown content identically.
 */
export const COMMON_CONTENT_CSS = `
  .katex-display{overflow-x:auto;overflow-y:hidden;}
  .commonmark-diagram{margin:0.8em 0;text-align:center;}
  .commonmark-diagram pre{text-align:left;}
  /* Mermaid diagrams rendered by the built-in-preview-compatible pipeline. */
  .markdown-body .mermaid{margin:0.8em 0;text-align:center;}
  .markdown-body .mermaid svg{max-width:100%;height:auto;}
  .markdown-body .mermaid-error{color:var(--vscode-editorError-foreground, #f48771);white-space:pre-wrap;font-family:var(--vscode-editor-font-family, monospace);font-size:var(--vscode-editor-font-size, 14px);}
  .markdown-body .md-mermaid{margin:0.8em 0;text-align:center;}
  .markdown-body .md-mermaid svg{max-width:100%;height:auto;}
  /* Preserve soft line breaks and indentation exactly like VS Code markdown
     preview (which also uses pre-wrap on <p>). */
  .markdown-body p{white-space:pre-wrap;}
  .markdown-body li{white-space:pre-wrap;}
  /* Typora-style unknown XML/HTML tags: shown as low-contrast grey text. */
  .markdown-body .md-html-tag{color:#a0a0a0;white-space:pre-wrap;}
  body.vscode-dark .markdown-body .md-html-tag{color:#8b949e;}
  /* Code blocks follow the theme instead of the fixed light github hljs theme. */
  .markdown-body pre{background-color:var(--vscode-textCodeBlock-background, var(--vscode-editor-background));}
  .markdown-body code.hljs{background:transparent;color:var(--vscode-editor-foreground);}
  .markdown-body pre code.hljs{font-family:var(--vscode-editor-font-family, monospace);}
`;

const COMMON_CSS = `
  html,body{margin:0;padding:0;height:100%;overflow:hidden;}
  body.vscode-body{padding:0;background-color:var(--vscode-editor-background);}
  #root{width:100%;height:100vh;overflow-y:auto;overflow-x:hidden;background:var(--vscode-editor-background);box-sizing:border-box;padding:1em 26px;}
  ${COMMON_CONTENT_CSS}
  /* Wide tables scroll horizontally inside their own box (GitHub-style) so
     narrow preview panes can reach every column, matching the built-in
     preview where the content can be scrolled to the right. Preview-only:
     exports keep normal document scrolling. */
  .markdown-body table{display:block;width:max-content;max-width:100%;overflow-x:auto;}
  /* Scroll beyond the last line like the built-in preview and the editor:
     keeps a full viewport-height of blank space below the content so the last
     line can sit in the middle of the preview, matching the editor's bottom
     behaviour. */
  .markdown-body::after{content:'';display:block;height:calc(100vh - 22px);}
  /* Floating buttons in the bottom-right corner of the preview:
     preview color scheme (left) and export (right). */
  #mcp-export-btn,#mcp-theme-btn{position:fixed;bottom:18px;width:36px;height:36px;padding:0;border:none;border-radius:8px;background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);cursor:pointer;opacity:.1;display:flex;align-items:center;justify-content:center;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.25);}
  #mcp-export-btn{right:18px;}
  #mcp-theme-btn{right:64px;}
  #mcp-export-btn:hover,#mcp-theme-btn:hover{opacity:1;}
  #mcp-export-btn:focus,#mcp-theme-btn:focus{outline:1px solid var(--vscode-focusBorder);}
  #mcp-export-btn svg,#mcp-theme-btn svg{width:18px;height:18px;fill:currentColor;}
`;

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Preview-only custom editor: renders the document with the CommonMark-style engine.
 */
class CommonMarkPreviewProviderImpl implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public static readonly viewType = "markdown-commonmark-preview.preview";

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    // Give the preview tab a dedicated icon (document + magnifier) so it is
    // visually distinct from a plain markdown file tab. The built-in preview
    // uses an eye icon; we intentionally use a different one.
    webviewPanel.iconPath = {
      light: vscode.Uri.file(path.join(this.context.extensionPath, "media", "preview-tab-light.svg")),
      dark: vscode.Uri.file(path.join(this.context.extensionPath, "media", "preview-tab-dark.svg")),
    };
    // localResourceRoots must cover the extension media (CSS/JS) AND the
    // folder containing the document (plus its workspace root) so relative
    // image paths in the markdown can be loaded by the webview.
    const resourceRoots: vscode.Uri[] = [
      vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      vscode.Uri.file(path.dirname(document.uri.fsPath))
    ];
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (wsFolder && !resourceRoots.some((r) => r.fsPath === wsFolder.uri.fsPath)) {
      resourceRoots.push(wsFolder.uri);
    }
    webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots
    };

    // Rewrite image src to absolute webview URIs so relative paths such as
    // `media/screenshots/light.png` or `./img.png` resolve against the file
    // that is being previewed (like the built-in Markdown preview does).
    const resolveImageSrc = (raw: string): string => {
      const href = decodeURI(raw).trim();
      if (!href) {
        return raw;
      }
      if (/^(https?:|data:|vscode-webview:|vscode-resource:)/i.test(href)) {
        return raw;
      }
      const target = path.isAbsolute(href)
        ? vscode.Uri.file(href)
        : vscode.Uri.file(path.normalize(path.join(path.dirname(document.uri.fsPath), href)));
      return webview.asWebviewUri(target).toString();
    };

    const cssUris = {
      katex: webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "katex", "katex.min.css"))),
      hljs: webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "vscode-highlight.css"))),
      markdown: webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", "vscode-markdown.css"))),
    };

    // Mermaid runtime, mirrors the built-in Markdown preview's mermaid bundle.
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "mermaid.min.js"))
    ).toString();

    // morphdom: incremental DOM diffing used by the built-in Markdown preview
    // (extensions/markdown-language-features/preview-src/index.ts). It patches
    // only the changed nodes, keeping already-rendered mermaid SVGs intact, so
    // re-renders do not rebuild the whole document on every keystroke.
    const morphdomUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "media", "morphdom.min.js"))
    ).toString();

    // The webview background/foreground colors follow the VS Code theme through
    // the --vscode-* CSS variables (like the built-in markdown preview). The
    // body gets a vscode-light/vscode-dark class to toggle border colors etc.
    //
    // `preview.colorScheme` can force the preview to the reference Light+ /
    // Dark+ palette without changing the real workbench theme. The webview
    // receives both the effective darkness and the selected scheme so it can
    // apply the palette overrides and the matching body class.
    const applyTheme = () => {
      const scheme = getPreviewColorScheme();
      webview.postMessage({
        type: "theme",
        dark: isEffectiveDark(scheme, vscode.window.activeColorTheme),
        scheme
      });
    };

    // First-paint content: mirror the built-in Markdown preview, which embeds
    // the rendered HTML in the webview's initial document (meta
    // data-initial-md-content) so the text appears immediately on load,
    // without waiting for the ready handshake / a render round-trip. The
    // webview parses it right away; the (large) mermaid bundle is loaded with
    // async so it never blocks first paint.
    const initialHtml = renderMarkdownBody(document.getText(), resolveImageSrc);

    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => {
      applyTheme();
    });
    const colorSchemeSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("markdown-commonmark-preview.preview.colorScheme")) {
        applyTheme();
      }
    });
    webviewPanel.onDidDispose(() => {
      themeSub.dispose();
      colorSchemeSub.dispose();
    });

    // The preview tab is opened with a unique query string to force a new
    // window, so compare URIs ignoring the query part.
    const baseUri = document.uri.with({ query: "" }).toString();

    // Initial scroll position: like the built-in preview (G(settings.line)),
    // embed the source editor's current top line into the webview's initial
    // document so it can scroll to it on first paint, before the ready
    // handshake / render round-trip. Fall back to 0 (top of document).
    const getInitialLine = (): number => {
      const ed = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.with({ query: "" }).toString() === baseUri
      ) || vscode.window.activeTextEditor;
      if (!ed) {
        return 0;
      }
      const isMd = /^(markdown|rmd|quarto)$/.test(ed.document.languageId)
        || ed.document.uri.path.endsWith(".txt");
      if (ed.document.uri.with({ query: "" }).toString() !== baseUri && !isMd) {
        return 0;
      }
      const vr = ed.visibleRanges[0];
      if (!vr) {
        return 0;
      }
      return vr.start.line;
    };
    const initialLine = getInitialLine();

    const initialScheme = getPreviewColorScheme();
    const initialDark = isEffectiveDark(initialScheme, vscode.window.activeColorTheme);
    webview.html = this.getHtml(webview, cssUris, initialDark, initialScheme, mermaidUri, morphdomUri, initialHtml, initialLine);

    // Handle the floating preview-color-scheme button before the ready
    // handshake so an early click is not lost (the main message handler is
    // installed inside ready.then below).
    const colorSchemeMessageSub = webview.onDidReceiveMessage((msg) => {
      if (msg && msg.type === "toggleColorScheme") {
        void togglePreviewColorScheme();
      }
    });
    webviewPanel.onDidDispose(() => colorSchemeMessageSub.dispose());

    // The preview's own document (its URI carries a unique query) is a
    // separate TextDocument snapshot: VS Code loads it once when the preview
    // opens and does NOT keep it in sync while the file is edited in a normal
    // text editor. Re-rendering from `document` would therefore always show
    // stale content. Mirror the built-in Markdown preview by re-rendering from
    // the live document the user actually edits (the one whose URI has no
    // query), falling back to the preview's document when no editor is open.
    const isSameFile = (uri: vscode.Uri): boolean =>
      uri.with({ query: "" }).toString() === baseUri;

    const findSourceDocument = (): vscode.TextDocument => {
      const candidates = vscode.workspace.textDocuments.filter((d) => isSameFile(d.uri));
      return candidates.find((d) => d.uri.query === "") ?? document;
    };

    // Wait for the webview to signal it is ready before sending the first
    // render, otherwise the message may be lost (blank preview).
    const ready = new Promise<void>((resolve) => {
      const sub = webview.onDidReceiveMessage((msg) => {
        if (msg.type === "ready") {
          sub.dispose();
          resolve();
        }
      });
      webviewPanel.onDidDispose(() => sub.dispose());
    });

    const render = (source?: vscode.TextDocument) => {
      const doc = source && isSameFile(source.uri) ? source : findSourceDocument();
      webview.postMessage({ type: "render", html: renderMarkdownBody(doc.getText(), resolveImageSrc) });
    };

    ready.then(() => {
      applyTheme();

      // Initial positioning on first paint is handled by the webview itself via
      // the embedded initialLine (G(settings.line) parity). The ready handshake
      // still triggers the first render and installs the scroll-sync listeners.
      render();

      const subs: vscode.Disposable[] = [];

      // Scroll sync only makes sense when the preview is side-by-side with the
      // source editor (i.e. they live in different editor groups/columns).
      // When the preview is stacked in the same group as the editor (e.g.
      // opened from the explorer context menu while the file is already open),
      // following every editor scroll would silently drag the hidden preview
      // around, which is surprising when the user switches back to it. This
      // matches the built-in Markdown preview intent: syncing is meaningful
      // only for side-by-side windows (Ctrl+K V / the toolbar icon).
      const isSideBySide = (editor?: vscode.TextEditor): boolean => {
        const previewColumn = webviewPanel.viewColumn;
        if (previewColumn === undefined) {
          return false;
        }
        const ed = editor ?? vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.with({ query: "" }).toString() === baseUri
        );
        if (!ed || ed.viewColumn === undefined) {
          return false;
        }
        return ed.viewColumn !== previewColumn;
      };

      // Document changes -> re-render from the changed document. Rendering
      // from the preview's own (stale) document would ignore the edit.
      //
      // Debounced like the built-in preview (extensions/markdown-language-features
      // src/preview/preview.ts: #delay = 300): the FIRST change renders
      // immediately, changes within the debounce window collapse into one
      // re-render. Without this every keystroke re-renders the full markdown
      // and re-runs every mermaid diagram, which is slow and makes scrolling
      // janky.
      let previewThrottleTimer: NodeJS.Timeout | undefined;
      let firstChangePending = true;
      const scheduleRender = (doc?: vscode.TextDocument) => {
        if (firstChangePending) {
          firstChangePending = false;
          render(doc);
          return;
        }
        if (previewThrottleTimer) {
          clearTimeout(previewThrottleTimer);
        }
        previewThrottleTimer = setTimeout(() => {
          previewThrottleTimer = undefined;
          render(doc);
        }, 300);
      };

      subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (isSameFile(e.document.uri)) {
          scheduleRender(e.document);
        }
      }));

      // Save also refreshes the preview: this covers documents that changed
      // without an open text editor (e.g. edited externally on disk), where
      // no change event is available for the live document.
      subs.push(vscode.workspace.onDidSaveTextDocument((e) => {
        if (isSameFile(e.uri)) {
          render();
        }
      }));

      // Editor scroll -> scroll the preview (scroll sync).
      // Mirror the built-in preview: send a fractional line number
      // (line + column proportion) so the webview can interpolate precisely.
      // Built-in uses a 50ms throttle (lodash throttle: leading + trailing),
      // so the preview follows continuously while the editor is scrolling
      // instead of only after it stops.
      // suppressUntil: when the preview scrolls the editor via revealRange,
      // the resulting visible-range change must NOT be echoed back as an
      // updateView, otherwise the preview gets dragged back to the editor's
      // viewport-top line (very visible when scrolling to top/bottom).
      let suppressEditorSyncUntil = 0;
      let pendingLine: number | undefined;
      let lastUpdateSent = 0;
      let updateTimer: NodeJS.Timeout | undefined;
      const sendUpdate = () => {
        if (pendingLine !== undefined) {
          webview.postMessage({ type: "updateView", line: pendingLine });
          pendingLine = undefined;
          lastUpdateSent = Date.now();
        }
      };
      subs.push(vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor.document.uri.with({ query: "" }).toString() !== baseUri) {
          return;
        }
        if (!isSideBySide(e.textEditor)) {
          return;
        }
        if (Date.now() < suppressEditorSyncUntil) {
          return;
        }
        const vr = e.visibleRanges[0];
        if (!vr) {
          return;
        }
        const n = vr.start.line;
        const text = e.textEditor.document.lineAt(n).text;
        pendingLine = n + vr.start.character / (text.length + 2);
        const remaining = 50 - (Date.now() - lastUpdateSent);
        if (remaining <= 0) {
          if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = undefined;
          }
          sendUpdate();
        } else if (!updateTimer) {
          updateTimer = setTimeout(() => {
            updateTimer = undefined;
            sendUpdate();
          }, remaining);
        }
      }));

      // Preview scroll -> scroll the editor (scroll sync).
      // Mirror the built-in preview exactly: convert the fractional line back
      // to a precise Range (built-in `rue`) and revealRange with AtTop so the
      // editor scrolls to that line's top on EVERY scroll event. Using
      // InCenterIfOutsideViewport would leave the editor unmoved while the
      // target line is still inside the viewport, making it feel laggy.
      subs.push(webview.onDidReceiveMessage((msg) => {
        if (msg.type === "export") {
          // Trigger the export command (format picker) from the floating
          // bottom-right button in the preview webview, targeting the source
          // document this preview renders.
          vscode.commands.executeCommand('markdown-commonmark-preview.export', findSourceDocument().uri);
          return;
        }
        if (msg.type === "toggleColorScheme") {
          // Handled by the early message listener registered next to the
          // webview HTML (so it also works before the ready handshake).
          return;
        }
        if (msg.type !== "revealLine") {
          return;
        }
        const line = Math.max(0, msg.line);
        const n = Math.floor(line);
        let range: vscode.Range;
        if (n >= document.lineCount) {
          range = new vscode.Range(document.lineCount - 1, 0, document.lineCount - 1, 0);
        } else {
          const frac = line - n;
          const t = document.lineAt(n).text;
          const col = Math.floor(frac * t.length);
          range = new vscode.Range(n, col, n + 1, 0);
        }
        // Mirror the built-in preview: scrolling the preview reveals the line
        // in EVERY visible editor showing this document that is side-by-side
        // with the preview, so when the same file is open in multiple parallel
        // windows they all scroll together.
        const matching = vscode.window.visibleTextEditors.filter(
          (ed) => ed.document.uri.with({ query: "" }).toString() === baseUri
        );
        let selected = matching.filter((ed) => isSideBySide(ed));
        if (selected.length === 0 && matching.length === 0) {
          // The file is not open in any visible editor (preview only); keep the
          // previous fallback so the active editor still follows.
          const active = vscode.window.activeTextEditor;
          if (active) {
            selected = [active];
          }
        }
        if (selected.length === 0) {
          return;
        }
        suppressEditorSyncUntil = Date.now() + 200;
        for (const editor of selected) {
          editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
        }
      }));

      webviewPanel.onDidDispose(() => subs.forEach((s) => s.dispose()));
    });
  }

  private getHtml(webview: vscode.Webview, css: any, initialDark: boolean, initialScheme: PreviewColorScheme, mermaidSrc: string, morphdomSrc: string, initialHtml: string, initialLine: number): string {
    const nonce = getNonce();
    // Built-in preview embeds the rendered content in data-initial-md-content so
    // the webview can paint text before any script round-trip. Escape attribute
    // like the built-in (util/dom.ts escapeAttribute).
    const escapeAttribute = (value: string): string =>
      value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    // Only force a reference theme when the user explicitly selected one.
    // "auto" leaves the attribute absent, so the webview's real VS Code theme
    // variables and body classes are used exactly as before.
    const previewThemeAttribute = initialScheme === "auto" ? "" : ` data-preview-theme="${initialScheme}"`;
    const themeLabels = {
      auto: localize("ui.preview.colorScheme.auto"),
      light: localize("ui.preview.colorScheme.light"),
      dark: localize("ui.preview.colorScheme.dark")
    };
    const themeLabelsJson = JSON.stringify(themeLabels).replace(/</g, "\\u003c");
    const themeButtonTitle = escapeAttribute(themeLabels[initialScheme] || themeLabels.auto);
    return `<!DOCTYPE html>
<html lang="zh-CN"${previewThemeAttribute}>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta id="vscode-markdown-preview-data" data-initial-md-content="${escapeAttribute(initialHtml)}" data-initial-line="${initialLine}">
<link rel="stylesheet" href="${css.katex}">
<link rel="stylesheet" href="${css.hljs}">
<link rel="stylesheet" href="${css.markdown}">
<style>${COMMON_CSS}</style>
<style>${renderPreviewColorSchemeCss()}</style>
</head>
<body class='vscode-body ${initialDark ? "vscode-dark" : "vscode-light"}'>
<div id="root">
<div class="markdown-body" id="write"></div>
</div>
<button id="mcp-theme-btn" data-scheme="${initialScheme}" title="${themeButtonTitle}" aria-label="${themeButtonTitle}">
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2v16a8 8 0 0 1 0-16z"/></svg>
</button>
<button id="mcp-export-btn" title="Export Markdown CommonMark document" aria-label="Export Markdown CommonMark document">
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1zM4 20a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1z"/></svg>
</button>
<script nonce="${nonce}" async src="${mermaidSrc}"></script>
<script nonce="${nonce}" async src="${morphdomSrc}"></script>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const markdownBody = document.getElementById('write');
  let syncing = false;
  let syncTimer = null;

  // Floating export button (bottom-right): asks the extension host to run the
  // export command (format picker) for the current markdown document.
  const exportBtn = document.getElementById('mcp-export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'export' });
    });
  }

  // Floating preview color-scheme button (bottom-right, left of export):
  // cycles auto -> light -> dark through the extension host, which persists
  // the setting and broadcasts the new effective theme to every open preview.
  const themeBtn = document.getElementById('mcp-theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'toggleColorScheme' });
    });
  }

  // ---- Preview color scheme -------------------------------------------
  // While a scheme is forced, the preview overrides the webview's theme
  // variables (the palette CSS is generated by the extension host) and keeps
  // the body classes in sync even if VS Code resets them when the real
  // workbench theme changes. In "auto" mode none of this interferes.
  let desiredDark = null;
  let applyingBodyTheme = false;
  const THEME_CLASSES = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];

  function clearThemeClasses() {
    for (const cls of THEME_CLASSES) {
      if (document.body.classList.contains(cls)) {
        document.body.classList.remove(cls);
      }
    }
  }

  function applyBodyTheme(dark) {
    applyingBodyTheme = true;
    try {
      clearThemeClasses();
      document.body.classList.add(dark ? 'vscode-dark' : 'vscode-light');
    } finally {
      applyingBodyTheme = false;
    }
  }

  // Restore the class set that the webview host applied for the real theme.
  // The host records the real theme kind in data-vscode-theme-kind; unlike the
  // body classes, that attribute is not overwritten by the forced preview.
  function restoreActualBodyTheme(actualDark) {
    applyingBodyTheme = true;
    try {
      clearThemeClasses();
      const kind = document.body.dataset.vscodeThemeKind;
      if (kind === 'vscode-high-contrast-light') {
        document.body.classList.add('vscode-high-contrast-light', 'vscode-high-contrast');
      } else if (kind === 'vscode-high-contrast' || kind === 'vscode-dark' || kind === 'vscode-light') {
        document.body.classList.add(kind);
      } else {
        document.body.classList.add(actualDark ? 'vscode-dark' : 'vscode-light');
      }
    } finally {
      applyingBodyTheme = false;
    }
  }

  function updateThemeButton(scheme) {
    if (!themeBtn) {
      return;
    }
    const labels = ${themeLabelsJson};
    const label = labels[scheme] || labels.auto;
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
    themeBtn.setAttribute('data-scheme', scheme || 'auto');
  }

  const initialRawScheme = document.documentElement.dataset.previewTheme;
  const initialScheme = initialRawScheme === 'light' || initialRawScheme === 'dark' ? initialRawScheme : 'auto';
  if (initialScheme === 'light' || initialScheme === 'dark') {
    desiredDark = initialScheme === 'dark';
    applyBodyTheme(desiredDark);
  }
  updateThemeButton(initialScheme);

  // The webview host removes and re-adds the theme classes whenever the real
  // workbench theme changes. In forced mode, put our class back; in auto mode,
  // leave the host's classes untouched.
  const bodyThemeObserver = new MutationObserver(function () {
    if (applyingBodyTheme || desiredDark === null) {
      return;
    }
    const want = desiredDark ? 'vscode-dark' : 'vscode-light';
    const other = desiredDark ? 'vscode-light' : 'vscode-dark';
    if (!document.body.classList.contains(want)
        || document.body.classList.contains(other)
        || document.body.classList.contains('vscode-high-contrast')
        || document.body.classList.contains('vscode-high-contrast-light')) {
      applyBodyTheme(desiredDark);
    }
  });
  bodyThemeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });

  function applyPreviewTheme(m) {
    const rawScheme = m && m.scheme;
    const scheme = rawScheme === 'light' || rawScheme === 'dark' ? rawScheme : 'auto';
    if (scheme === 'auto') {
      delete document.documentElement.dataset.previewTheme;
      desiredDark = null;
      restoreActualBodyTheme(!!m.dark);
    } else {
      document.documentElement.dataset.previewTheme = scheme;
      desiredDark = !!m.dark;
      applyBodyTheme(desiredDark);
    }
    updateThemeButton(scheme);
    renderMermaid().then(function () { rebuildLineEls(); });
  }

  // =====================================================================
  // First paint: the extension embeds the rendered document in
  // data-initial-md-content (mirroring the built-in preview). Parse and
  // insert it synchronously so text is visible immediately, before the
  // ready handshake and before the large mermaid bundle finishes loading.
  //
  // The mermaid bundle is loaded with async, so it may start running right
  // after load while the DOM already contains .mermaid elements. Its default
  // startOnLoad=true would auto-render them with the default theme before we
  // have called initialize({startOnLoad:false}) with the VS Code theme
  // variables. Temporarily rename .mermaid so the auto-run finds nothing;
  // whenMermaidReady() restores the class right before rendering with the
  // correct theme (the built-in avoids this race because its small index.js
  // initializes mermaid before the large bundle finishes loading).
  // =====================================================================
  (function renderInitialContent() {
    const data = document.getElementById('vscode-markdown-preview-data');
    const content = data && data.getAttribute('data-initial-md-content');
    if (content) {
      // Use childNodes (including whitespace text nodes) so the initial DOM
      // exactly matches what the render message will later feed to morphdom;
      // mixing .children (element-only) with .childNodes (with text) would
      // offset every node and make morphdom rebuild the whole document.
      const nodes = Array.from(new DOMParser().parseFromString(content, 'text/html').body.childNodes);
      markdownBody.append(...nodes);
      markdownBody.querySelectorAll('.mermaid').forEach((el) => {
        el.classList.remove('mermaid');
        el.classList.add('mermaid-pending');
      });

      // Initial scroll position: mirror the built-in preview's G(settings.line)
      // on first paint. The embedded data-initial-line carries the source
      // editor's current top line so the preview opens scrolled to the same
      // place as the editor, without waiting for the ready handshake / render
      // round-trip. Deferred so the initial content is laid out first; the
      // built-in also defers initial positioning (le() waits for images).
      const dataEl = document.getElementById('vscode-markdown-preview-data');
      const initialLineRaw = dataEl && dataEl.getAttribute('data-initial-line');
      const initialLine = initialLineRaw === null ? 0 : +initialLineRaw;
      setTimeout(() => {
        if (isNaN(initialLine)) {
          return;
        }
        rebuildLineEls();
        scrollToLine(initialLine);
      }, 0);
    }
  })();

  // Disable mermaid's automatic run() on DOMContentLoaded (default
  // startOnLoad=true would render every .mermaid block with the default theme
  // before we have applied the VS Code theme variables). Rendering is driven
  // by renderMermaid() on 'render'/'theme' messages from the extension host.
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false });
  }

  // =====================================================================
  // Verbatim port of the built-in Markdown preview's scroll-sync machinery
  // (media/index.js: the _ class, ee(), R(), at(), me(), q(), G(), Me()).
  //
  // lineEls entries mirror the built-in _ instances:
  //   { element, line, codeElement?, endLine? }
  // - element: the element used for geometry (PRE for code blocks)
  // - line:    source line number of the element's first line
  // - codeElement: the <code> inside a <pre> (fenced code), if any
  // - endLine: last source line of the element (code blocks only)
  // The sentinel { element: document.body, line: -1 } maps the very top of
  // the document to line 0.
  // =====================================================================
  let lineEls = [];

  function rebuildLineEls() {
    lineEls = [{ element: document.body, line: -1 }];
    const nodes = markdownBody.querySelectorAll('[data-line]');
    for (const n of nodes) {
      if (!(n instanceof HTMLElement)) continue;
      const i = +n.getAttribute('data-line');
      if (isNaN(i)) continue;
      if (n.tagName === 'CODE' && n.parentElement && n.parentElement.tagName === 'PRE') {
        // Fenced code: the data-line lives on the <code> (markdown-it puts the
        // token attrs there). Track the <pre> for geometry, and the code's
        // endLine so the inside of the block maps line-for-line.
        const lines = ((n.textContent || '').match(/\\n/g) || []).length + 1;
        lineEls.push({ element: n.parentElement, line: i, codeElement: n, endLine: i + lines - 1 });
      } else if (n.tagName !== 'PRE' && n.tagName !== 'UL' && n.tagName !== 'OL') {
        lineEls.push({ element: n, line: i });
      }
    }
  }

  // =====================================================================
  // Mermaid diagram rendering.
  //
  // Faithful port of the built-in mermaid-markdown-features webview
  // (vscode/extensions/mermaid-markdown-features/preview-src/shared/):
  //   - vsCodeTheme.ts  : derive mermaid themeVariables from the live VS Code
  //                       CSS variables (theme: 'base' + themeVariables)
  //   - index.ts        : renderMermaidBlocksInElement / renderMermaidElement
  //
  // The markdown-it plugin emits every mermaid block as an element with class
  // mermaid (fenced mermaid blocks become <pre class="mermaid">, the
  // :::mermaid container becomes <div class="mermaid">). Here we replace
  // each element's content with the SVG mermaid.render() produces. The source
  // text is kept in dataset.source so diagrams can be re-rendered with new
  // themeVariables when the VS Code theme changes.
  // =====================================================================

  function isDarkVsCodeTheme() {
    // The forced preview scheme is authoritative: the body classes are kept in
    // sync by applyBodyTheme, but they may briefly lag behind while the host
    // is re-applying the real theme's classes.
    const forced = document.documentElement.dataset.previewTheme;
    if (forced === 'dark') {
      return true;
    }
    if (forced === 'light') {
      return false;
    }
    return document.body.classList.contains('vscode-dark')
      || (document.body.classList.contains('vscode-high-contrast') && !document.body.classList.contains('vscode-high-contrast-light'));
  }

  function rgbStringToHex(value) {
    const match = value.match(/^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$/);
    if (!match) {
      return undefined;
    }
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    const a = match[4] !== undefined ? Math.round(parseFloat(match[4]) * 255) : 255;
    const hex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return a < 255
      ? '#' + hex(r) + hex(g) + hex(b) + hex(a)
      : '#' + hex(r) + hex(g) + hex(b);
  }

  function resolveCssColor(cssValue) {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = cssValue;
    document.body.appendChild(probe);
    try {
      return rgbStringToHex(getComputedStyle(probe).color);
    } finally {
      probe.remove();
    }
  }

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function pickColor() {
    for (const name of arguments) {
      if (!readCssVar(name)) {
        continue;
      }
      const hex = resolveCssColor('var(' + name + ')');
      if (hex) {
        return hex;
      }
    }
    return undefined;
  }

  function computeVsCodeMermaidThemeVariables() {
    const variables = { darkMode: isDarkVsCodeTheme() };
    function set(key) {
      const color = pickColor.apply(null, Array.prototype.slice.call(arguments, 1));
      if (color) {
        variables[key] = color;
      }
    }

    set('background', '--vscode-editor-background');
    set('textColor', '--vscode-charts-foreground', '--vscode-editor-foreground', '--vscode-foreground');
    set('lineColor', '--vscode-chart-line', '--vscode-charts-lines', '--vscode-editor-foreground', '--vscode-foreground');

    set('primaryColor', '--vscode-editorWidget-background');
    set('primaryTextColor', '--vscode-charts-foreground', '--vscode-editor-foreground', '--vscode-foreground');
    set('primaryBorderColor', '--vscode-chart-line', '--vscode-editorWidget-border', '--vscode-focusBorder');
    set('mainBkg', '--vscode-editorWidget-background');
    set('nodeBorder', '--vscode-chart-line', '--vscode-editorWidget-border', '--vscode-focusBorder');

    set('secondaryColor', '--vscode-input-background', '--vscode-editorWidget-background');
    set('secondaryTextColor', '--vscode-input-foreground', '--vscode-foreground');
    set('secondaryBorderColor', '--vscode-input-border', '--vscode-editorWidget-border');

    set('tertiaryColor', '--vscode-textBlockQuote-background', '--vscode-input-background');
    set('tertiaryTextColor', '--vscode-foreground');
    set('tertiaryBorderColor', '--vscode-textBlockQuote-border', '--vscode-editorWidget-border');
    set('clusterBkg', '--vscode-textBlockQuote-background', '--vscode-input-background');
    set('clusterBorder', '--vscode-textBlockQuote-border', '--vscode-editorWidget-border');

    set('noteBkgColor', '--vscode-textBlockQuote-background', '--vscode-editorWidget-background');
    set('noteTextColor', '--vscode-foreground');
    set('noteBorderColor', '--vscode-textBlockQuote-border', '--vscode-editorWidget-border');

    set('errorBkgColor', '--vscode-inputValidation-errorBackground', '--vscode-editorError-background');
    set('errorTextColor', '--vscode-editorError-foreground', '--vscode-foreground');

    set('titleColor', '--vscode-charts-foreground', '--vscode-editor-foreground', '--vscode-foreground');
    set('edgeLabelBackground', '--vscode-editor-background');

    const chartPalette = [
      '--vscode-charts-blue',
      '--vscode-charts-green',
      '--vscode-charts-orange',
      '--vscode-charts-red',
      '--vscode-charts-purple',
      '--vscode-charts-yellow',
    ];
    for (let i = 0; i < chartPalette.length; i++) {
      set('pie' + (i + 1), chartPalette[i]);
      set('cScale' + i, chartPalette[i]);
    }

    const fontFamily = readCssVar('--vscode-font-family');
    if (fontFamily) {
      variables.fontFamily = fontFamily;
    }
    const fontSize = readCssVar('--vscode-font-size');
    if (fontSize) {
      variables.fontSize = fontSize;
    }
    return variables;
  }

  function getMermaidErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === 'object') {
      const candidate = error;
      if (typeof candidate.message === 'string' && candidate.message) {
        return candidate.message;
      }
      if (typeof candidate.str === 'string' && candidate.str) {
        return candidate.str;
      }
    }
    return String(error);
  }

  let mermaidSeq = 0;
  let lastMermaidThemeFingerprint = '';
  function renderMermaid() {
    if (typeof mermaid === 'undefined') {
      return Promise.resolve();
    }

    const themeVariables = computeVsCodeMermaidThemeVariables();
    const fingerprint = JSON.stringify(themeVariables);
    const themeChanged = fingerprint !== lastMermaidThemeFingerprint;
    lastMermaidThemeFingerprint = fingerprint;

    // Only re-initialize mermaid when the theme actually changed. initialize()
    // is expensive (it resets every diagram's config), so calling it on every
    // render makes typing janky. The built-in mermaid-markdown-features webview
    // does exactly this: initialize happens once, render() reuses the config.
    if (themeChanged) {
      mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables });
    }

    const tasks = [];
    const usedIds = new Set();

    const renderOne = (container) => {
      const source = (container.textContent || '').trim();
      if (!source) {
        return;
      }
      // Skip diagrams whose source did not change since the last render: the
      // previous SVG is still in the DOM (kept by the render message handler
      // which re-uses existing mermaid containers instead of re-setting
      // innerHTML for unchanged sources). Re-rendering unchanged diagrams on
      // every keystroke is the main source of input latency.
      if (container.dataset.source === source && container.querySelector('svg')) {
        return;
      }
      container.dataset.source = source;
      let id = 'mermaid-' + (mermaidSeq++);
      while (usedIds.has(id)) {
        id = 'mermaid-' + (mermaidSeq++);
      }
      usedIds.add(id);
      tasks.push(mermaid.parse(source).then(() => mermaid.render(id, source)).then(({ svg }) => {
        container.innerHTML = svg;
      }).catch((error) => {
        const pre = document.createElement('pre');
        pre.className = 'mermaid-error';
        pre.innerText = getMermaidErrorMessage(error);
        container.innerHTML = '';
        container.appendChild(pre);
      }));
    };

    // Re-render every diagram when the theme changed so colours follow the
    // VS Code theme (sources are still in dataset.source after first render).
    if (themeChanged) {
      markdownBody.querySelectorAll('.mermaid[data-rendered="true"]').forEach((el) => {
        el.innerHTML = '';
        if (el.dataset.source) {
          el.textContent = el.dataset.source;
        }
        el.dataset.rendered = 'false';
      });
    }

    // Fresh (unrendered) mermaid blocks emitted by the markdown-it plugin.
    markdownBody.querySelectorAll('.mermaid:not([data-rendered="true"])').forEach((container) => {
      container.dataset.rendered = 'true';
      renderOne(container);
    });

    return Promise.all(tasks);
  }

  // Built-in isVisible: skip hidden/collapsed/zero-size elements.
  function isVisible(item) {
    const el = item.element;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return !(r.height === 0 || r.width === 0);
  }

  // Built-in R(e): rect relative to the root's viewport. For elements without
  // a codeElement, the height is clipped to the first nested [data-line]
  // descendant (so the body sentinel stops covering the viewport once the
  // first element scrolls past the top).
  function R(item) {
    const rootR = root.getBoundingClientRect();
    const n = item.element.getBoundingClientRect();
    const top = n.top - rootR.top;
    if (item.codeElement) return { top, height: n.height };
    const child = item.element.querySelector('[data-line]');
    if (child) {
      const o = child.getBoundingClientRect();
      const h = Math.max(1, o.top - n.top);
      return { top, height: h };
    }
    return { top, height: n.height };
  }

  // Built-in Me(e): like R, but for code elements subtracts the <pre> padding
  // so interpolation inside a code block is over the visible code area.
  function Me(item) {
    const n = R(item);
    if (item.codeElement) {
      const cs = window.getComputedStyle(item.element);
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      return { top: n.top + pt, height: n.height - pt - pb };
    }
    return { top: n.top, height: n.height };
  }

  // Built-in q(e): previous = element with line == floor(e) (next is null ->
  // interpolate INSIDE that element); otherwise previous = element with the
  // greatest line < floor(e) and next = element with the smallest line > it.
  function q(line) {
    const r = Math.floor(line);
    let prev = lineEls[0] || null;
    for (const o of lineEls) {
      if (o.line === r) return { prev: o, next: null };
      if (o.line > r) return { prev, next: o };
      prev = o;
    }
    return { prev };
  }

  // Built-in at(e): binary search for the element whose box covers the
  // viewport top (viewport top is y=0 relative to the root's viewport).
  function at() {
    const r = lineEls.filter(isVisible);
    const n = 0;
    let i = -1;
    let o = r.length - 1;
    while (i + 1 < o) {
      const l = Math.floor((i + o) / 2);
      const u = R(r[l]);
      if (u.top + u.height >= n) { o = l; } else { i = l; }
    }
    const a = r[o];
    if (!a) return { prev: null };
    const s = R(a);
    if (o >= 1 && s.top > n) {
      // Viewport top is in the gap above this element.
      return { prev: r[i], next: a };
    }
    if (o > 1 && o < r.length && s.top + s.height > n) {
      // Viewport top is inside this element.
      return { prev: a, next: r[o + 1] };
    }
    return { prev: a };
  }

  // Built-in me(e): preview scrollTop -> fractional line number.
  function lineFromScroll() {
    const { prev: r, next: n } = at();
    if (!r) return 0;
    if (r.line < 0) return 0;
    const i = R(r);
    // o = distance from the viewport top (0) down into r's top.
    const o = -i.top;
    if (r.endLine && r.endLine > r.line) {
      const a = Me(r);
      const s = -a.top;
      if (s >= 0 && s <= a.height) {
        const l = s / a.height;
        return r.line + l * (r.endLine - r.line);
      } else if (n && s > a.height) {
        const l = s - a.height;
        const u = R(n);
        const b = a.top + a.height;
        const v = u.top - b;
        const E = l / v;
        return r.endLine + E * (n.line - r.endLine);
      }
      // s < 0: viewport top above the code block -> generic interpolation.
    }
    if (n) {
      const a = o / (R(n).top - i.top);
      return r.line + a * (n.line - r.line);
    } else {
      const a = o / i.height;
      return r.line + a;
    }
  }

  // Built-in G(e): editor line -> preview scrollTop (absolute document
  // position = root.scrollTop + rect.top).
  function scrollToLine(line) {
    syncing = true;
    if (line <= 0) {
      root.scrollTop = 0;
    } else {
      const { prev: n, next: i } = q(line);
      if (n) {
        const a = R(n);
        const s = a.top;
        let o;
        if (n.endLine && n.endLine > n.line) {
          if (line < n.endLine) {
            // Target is inside the code block: interpolate over the visible
            // code area (pre padding removed).
            const l = Me(n);
            const u = (line - n.line) / (n.endLine - n.line);
            o = root.scrollTop + l.top + l.height * u;
          } else if (i && i.line !== n.line) {
            const l = (line - n.endLine) / (i.line - n.endLine);
            const u = root.scrollTop + s + a.height;
            const v = root.scrollTop + R(i).top - u;
            o = u + l * v;
          } else {
            o = root.scrollTop + s + a.height;
          }
        } else if (i && i.line !== n.line) {
          const l = (line - n.line) / (i.line - n.line);
          const u = root.scrollTop + s + a.height;
          const v = root.scrollTop + R(i).top - u;
          o = u + l * v;
        } else {
          // Inside the matched element or past the last element: scale by the
          // fractional part so the very bottom extends past the last element,
          // matching scrollBeyondLastLine on both sides.
          const l = line - Math.floor(line);
          o = root.scrollTop + s + a.height * l;
        }
        root.scrollTop = Math.max(1, o);
      }
    }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncing = false; }, 100);
  }

  // Built-in: scroll is wrapped in a 50ms throttle (lodash throttle:
  // leading + trailing), so while the preview is scrolling the editor follows
  // continuously instead of only after the scroll stops.
  let lastRevealSent = 0;
  let revealTimer = null;
  function sendReveal() {
    if (syncing) return;
    const line = lineFromScroll();
    if (typeof line === 'number' && !isNaN(line)) {
      vscode.postMessage({ type: 'revealLine', line });
      lastRevealSent = Date.now();
    }
  }
  function onAnyScroll() {
    const remaining = 50 - (Date.now() - lastRevealSent);
    if (remaining <= 0) {
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      sendReveal();
    } else if (!revealTimer) {
      revealTimer = setTimeout(() => { revealTimer = null; sendReveal(); }, remaining);
    }
  }
  root.addEventListener('scroll', onAnyScroll);

  // Built-in le(): wait for images to finish loading before positioning, so a
  // reflow caused by a late-loading image does not make the scroll target drift.
  function afterImages(cb) {
    const imgs = markdownBody.getElementsByTagName('img');
    if (imgs.length > 0) {
      const waits = Array.from(imgs, (n) => n.complete
        ? Promise.resolve()
        : new Promise((res) => { n.addEventListener('load', () => res()); n.addEventListener('error', () => res()); }));
      Promise.all(waits).then(() => setTimeout(cb, 0));
    } else {
      setTimeout(cb, 0);
    }
  }

  window.addEventListener('resize', () => {
    syncing = true;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncing = false; }, 200);
  }, true);

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'render') {
      // Incremental DOM update exactly like the built-in Markdown preview
      // (extensions/markdown-language-features/preview-src/index.ts
      //  'updateContent' handler): parse the new content and let morphdom
      //  patch only the changed nodes. Already-rendered mermaid containers
      //  whose source did not change are kept (their <svg> is preserved), so
      //  typing does not re-run every diagram.
      const parser = new DOMParser();
      const newContent = parser.parseFromString(m.html, 'text/html');
      for (const metaElement of Array.from(newContent.querySelectorAll('meta'))) {
        if (metaElement.hasAttribute('http-equiv')) {
          metaElement.remove();
        }
      }
      const newRoot = newContent.querySelector('.markdown-body') || newContent.body;
      // Node equality mirroring the built-in Markdown preview
      // (preview-src/index.ts: areNodesEqual). A node is "equal" when a full
      // morphdom update would be a no-op: same tag, text, and attributes
      // (skipping 'open' for details and 'data-line', which is copied over
      // separately). Notably this treats an already-rendered mermaid container
      // (whose content is the generated <svg>) as different from the incoming
      // raw-source <pre class="mermaid">, so the first branch below handles
      // the mermaid keep/drop decision before the generic comparison.
      const areNodesEqual = (a, b) => {
        const skippedAttrs = ['open'];
        if (a.isEqualNode(b)) {
          return true;
        }
        if (a.tagName !== b.tagName || a.textContent !== b.textContent) {
          return false;
        }
        const aAttrs = Array.from(a.attributes).filter(attr => !skippedAttrs.includes(attr.name));
        const bAttrs = Array.from(b.attributes).filter(attr => !skippedAttrs.includes(attr.name));
        if (aAttrs.length !== bAttrs.length) {
          return false;
        }
        for (let i = 0; i < aAttrs.length; ++i) {
          const aAttr = aAttrs[i];
          const bAttr = bAttrs[i];
          if (aAttr.name !== bAttr.name) {
            return false;
          }
          if (aAttr.value !== bAttr.value && aAttr.name !== 'data-line') {
            return false;
          }
        }
        const aChildren = Array.from(a.children);
        const bChildren = Array.from(b.children);
        return aChildren.length === bChildren.length && aChildren.every((x, i) => areNodesEqual(x, bChildren[i]));
      };
      morphdom(markdownBody, newRoot, {
        childrenOnly: true,
        onBeforeElUpdated: (fromEl, toEl) => {
          // Mermaid containers: the live node's content is the rendered
          // <svg>, the incoming node still holds the raw source, so a plain
          // equality comparison would wrongly replace the rendered diagram.
          // Compare against the stored source instead and keep the live SVG.
          if (fromEl instanceof HTMLElement && fromEl.classList.contains('mermaid')) {
            const newSrc = (toEl.textContent || '').trim();
            if (fromEl.dataset.source === newSrc && fromEl.querySelector('svg')) {
              return false;
            }
          }
          if (areNodesEqual(fromEl, toEl)) {
            // areEqual doesn't look at 'data-line' so copy those over manually
            const fromLines = fromEl.querySelectorAll('[data-line]');
            const toLines = toEl.querySelectorAll('[data-line]');
            for (let i = 0; i < fromLines.length; ++i) {
              const fromChild = fromLines[i];
              const toChild = toLines[i];
              if (toChild) {
                fromChild.setAttribute('data-line', toChild.getAttribute('data-line') || '');
              }
            }
            return false;
          }
          if (fromEl.tagName === 'DETAILS' && toEl.tagName === 'DETAILS') {
            if (fromEl.hasAttribute('open')) {
              toEl.setAttribute('open', '');
            }
          }
          return true;
        }
      });
      renderMermaid().then(() => rebuildLineEls());
    } else if (m.type === 'theme') {
      applyPreviewTheme(m);
    } else if (m.type === 'updateView') {
      afterImages(() => scrollToLine(m.line));
    }
  });
  // The mermaid bundle is loaded with async so it never blocks first paint
  // (the initial content is already in the DOM). Once it finishes loading,
  // render the first-paint diagrams before signalling ready, so the extension
  // host's follow-up render message does not race an unloaded mermaid. If it
  // is already available (cached), render synchronously.
  const whenMermaidReady = () => {
    if (typeof mermaid !== 'undefined' && typeof mermaid.render === 'function') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (typeof mermaid !== 'undefined' && typeof mermaid.render === 'function') {
          clearInterval(poll);
          resolve();
        }
      }, 30);
      // Safety: never wait forever even if the bundle fails to load.
      setTimeout(() => { clearInterval(poll); resolve(); }, 10000);
    });
  };
  whenMermaidReady().then(() => {
    // Restore the .mermaid class that renderInitialContent temporarily renamed
    // (see the first-paint block) so renderMermaid() can find the diagrams.
    markdownBody.querySelectorAll('.mermaid-pending').forEach((el) => {
      el.classList.remove('mermaid-pending');
      el.classList.add('mermaid');
    });
    mermaid.initialize({ startOnLoad: false });
    return renderMermaid();
  }).then(() => {
    // Diagrams are in place and the document height is final: re-apply the
    // initial scroll position so it is not shifted by the SVG reflows (mirrors
    // the built-in restoring scrollProgress after mermaid renders).
    const dataEl = document.getElementById('vscode-markdown-preview-data');
    const initialLineRaw = dataEl && dataEl.getAttribute('data-initial-line');
    const initialLine = initialLineRaw === null ? 0 : +initialLineRaw;
    if (!isNaN(initialLine)) {
      rebuildLineEls();
      scrollToLine(initialLine);
    }
    vscode.postMessage({ type: 'ready' });
  });
})();
</script>
</body>
</html>`;
  }
}

/**
 * "编辑" custom editor.
 *
 * Per requirement, opening a .md via "Open With -> xxx编辑" must behave exactly like
 * Markdown All in One / the normal VS Code editor: i.e. just the regular text editor.
 * So we do not render a split-pane webview; instead we forward to the built-in editor
 * and immediately dispose this custom editor panel.
 */
class CommonMarkEditorProviderImpl implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "markdown-commonmark-preview.editor";

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Forward to the normal text editor and close this placeholder panel.
    await vscode.commands.executeCommand("vscode.open", document.uri, {
      preview: false,
      preserveFocus: false
    });
    webviewPanel.dispose();
  }
}

export class CommonMarkEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const openCmd = vscode.commands.registerCommand("markdown-commonmark-preview.openWithEditor", (uri?: vscode.Uri) => {
      return openWithCustomEditor(uri, CommonMarkEditorProviderImpl.viewType);
    });
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(
        CommonMarkEditorProviderImpl.viewType,
        new CommonMarkEditorProviderImpl(),
        { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } }
      ),
      openCmd
    );
  }
}

export class CommonMarkPreviewProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const openCmd = vscode.commands.registerCommand("markdown-commonmark-preview.openWithPreview", (uri?: vscode.Uri) => {
      return openWithCustomEditor(uri, CommonMarkPreviewProviderImpl.viewType);
    });
    // Context-menu entry (explorer / editor tab): opens the preview stacked in
    // the same window instead of side-by-side.
    const openInPlaceCmd = vscode.commands.registerCommand("markdown-commonmark-preview.openWithPreviewInPlace", (uri?: vscode.Uri) => {
      return openWithCustomEditor(uri, CommonMarkPreviewProviderImpl.viewType, true);
    });
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(
        CommonMarkPreviewProviderImpl.viewType,
        new CommonMarkPreviewProviderImpl(context),
        { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } }
      ),
      openCmd,
      openInPlaceCmd
    );
  }
}

/**
 * Opens the given document with a custom editor via the built-in `vscode.openWith`.
 * Falls back to the active editor when no uri is provided.
 *
 * For the preview, a unique timestamp query is appended to the URI so VS Code
 * treats every invocation as a brand new resource and opens an additional tab
 * instead of reusing/overwriting an already-open preview window.
 */
async function openWithCustomEditor(uri: vscode.Uri | undefined, viewType: string, inPlace: boolean = false): Promise<void> {
  if (!uri) {
    const editor = vscode.window.activeTextEditor;
    if (
      editor &&
      (
        /^(markdown|rmd|quarto)$/.test(editor.document.languageId) ||
        editor.document.uri.path.endsWith(".txt")
      )
    ) {
      uri = editor.document.uri;
    }
  }
  if (!uri) {
    vscode.window.showInformationMessage("No Markdown document is active.");
    return;
  }

  const preview = viewType === CommonMarkPreviewProviderImpl.viewType;
  let target = uri;

  // Decide where to open the preview. The target group is computed from the
  // currently active group: for the context-menu entry (`inPlace`) it is the
  // active group itself; for the toolbar icon / Ctrl+K K it is the group to
  // the right of the active one. If a preview of this document already exists
  // in that target group, just focus it instead of opening another preview
  // tab (mirrors the built-in preview). Otherwise a new preview is created in
  // that target group: stacked (inPlace) or side-by-side (right of the active
  // group). If the file is NOT open yet, side-by-side opening would leave an
  // empty column on the left, so open it in the active column instead. The
  // unique query makes VS Code treat each new invocation as a brand new
  // resource so a fresh parallel window is opened.
  let column: vscode.ViewColumn | undefined;
  if (preview) {
    const base = uri.with({ query: "" }).toString();
    const activeColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    const targetColumn = inPlace
      ? activeColumn
      : activeColumn !== undefined
        ? (activeColumn + 1) as vscode.ViewColumn
        : undefined;
    const existing = vscode.window.tabGroups.all
      .filter((g) => g.viewColumn === targetColumn)
      .flatMap((g) => g.tabs)
      .find(
        (t) =>
          t.input instanceof vscode.TabInputCustom &&
          t.input.viewType === CommonMarkPreviewProviderImpl.viewType &&
          t.input.uri.with({ query: "" }).toString() === base
      );
    if (existing && existing.input instanceof vscode.TabInputCustom) {
      await vscode.commands.executeCommand("vscode.openWith", existing.input.uri, viewType, targetColumn);
      return;
    }
    target = uri.with({ query: `commonmarkPreview=${Date.now()}` });
    if (inPlace) {
      column = targetColumn ?? vscode.ViewColumn.Active;
    } else {
      const alreadyOpen = vscode.window.visibleTextEditors.some(
        (ed) => ed.document.uri.with({ query: "" }).toString() === base
      );
      column = alreadyOpen ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    }
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    target,
    viewType,
    column
  );
}
