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

const COMMON_CSS = `
  html,body{margin:0;padding:0;height:100%;overflow:hidden;}
  body.vscode-body{padding:0;background-color:var(--vscode-editor-background);}
  #root{width:100%;height:100vh;overflow-y:auto;overflow-x:hidden;background:var(--vscode-editor-background);box-sizing:border-box;padding:1em 26px;}
  .katex-display{overflow-x:auto;overflow-y:hidden;}
  .commonmark-diagram{margin:0.8em 0;text-align:center;}
  .commonmark-diagram pre{text-align:left;}
  /* Preserve soft line breaks and indentation exactly like VS Code markdown
     preview (which also uses pre-wrap on <p>). */
  .markdown-body p{white-space:pre-wrap;}
  .markdown-body li{white-space:pre-wrap;}
  /* Scroll beyond the last line like the built-in preview and the editor:
     keeps a full viewport-height of blank space below the content so the last
     line can sit in the middle of the preview, matching the editor's bottom
     behaviour. */
  .markdown-body::after{content:'';display:block;height:calc(100vh - 22px);}
  /* Code blocks follow the theme instead of the fixed light github hljs theme. */
  .markdown-body pre{background-color:var(--vscode-textCodeBlock-background, var(--vscode-editor-background));}
  .markdown-body code.hljs{background:transparent;color:var(--vscode-editor-foreground);}
  .markdown-body pre code.hljs{font-family:var(--vscode-editor-font-family, monospace);}
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

    // The webview background/foreground colors follow the VS Code theme through
    // the --vscode-* CSS variables (like the built-in markdown preview). The
    // body gets a vscode-light/vscode-dark class to toggle border colors etc.
    const isDark = (theme: vscode.ColorTheme) =>
      theme.kind === vscode.ColorThemeKind.Dark || theme.kind === vscode.ColorThemeKind.HighContrast;

    const applyTheme = (dark: boolean) => {
      webview.postMessage({ type: "theme", dark });
    };

    webview.html = this.getHtml(webview, cssUris, isDark(vscode.window.activeColorTheme));

    const themeSub = vscode.window.onDidChangeActiveColorTheme((theme) => {
      applyTheme(isDark(theme));
    });
    webviewPanel.onDidDispose(() => themeSub.dispose());

    // The preview tab is opened with a unique query string to force a new
    // window, so compare URIs ignoring the query part.
    const baseUri = document.uri.with({ query: "" }).toString();

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

    const render = () => {
      webview.postMessage({ type: "render", html: renderMarkdownBody(document.getText(), resolveImageSrc) });
    };

    ready.then(() => {
      applyTheme(isDark(vscode.window.activeColorTheme));

      // Initial positioning: like the built-in preview (G(settings.line)),
      // scroll the preview to the source editor's current top line.
      const syncEditorToPreview = () => {
        const ed = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.with({ query: "" }).toString() === baseUri
        ) || vscode.window.activeTextEditor;
        if (!ed) {
          return;
        }
        const isMd = /^(markdown|rmd|quarto)$/.test(ed.document.languageId)
          || ed.document.uri.path.endsWith(".txt");
        if (ed.document.uri.with({ query: "" }).toString() !== baseUri && !isMd) {
          return;
        }
        const vr = ed.visibleRanges[0];
        if (!vr) {
          return;
        }
        const n = vr.start.line;
        const text = ed.document.lineAt(n).text;
        webview.postMessage({ type: "updateView", line: n + vr.start.character / (text.length + 2) });
      };

      render();
      syncEditorToPreview();

      const subs: vscode.Disposable[] = [];

      // Document changes -> re-render.
      subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.with({ query: "" }).toString() === baseUri) {
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
        if (msg.type !== "revealLine") {
          return;
        }
        let editor = vscode.window.visibleTextEditors.find(
          (ed) => ed.document.uri.with({ query: "" }).toString() === baseUri
        );
        if (!editor) {
          editor = vscode.window.activeTextEditor;
        }
        if (!editor) {
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
        suppressEditorSyncUntil = Date.now() + 200;
        editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
      }));

      webviewPanel.onDidDispose(() => subs.forEach((s) => s.dispose()));
    });
  }

  private getHtml(webview: vscode.Webview, css: any, initialDark: boolean): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css.katex}">
<link rel="stylesheet" href="${css.hljs}">
<link rel="stylesheet" href="${css.markdown}">
<style>${COMMON_CSS}</style>
</head>
<body class='vscode-body ${initialDark ? "vscode-dark" : "vscode-light"}'>
<div id="root">
<div class="markdown-body" id="write"></div>
</div>
<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const markdownBody = document.getElementById('write');
  let syncing = false;
  let syncTimer = null;

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
      markdownBody.innerHTML = m.html;
      rebuildLineEls();
    } else if (m.type === 'theme') {
      document.body.classList.toggle('vscode-dark', m.dark);
      document.body.classList.toggle('vscode-light', !m.dark);
    } else if (m.type === 'updateView') {
      afterImages(() => scrollToLine(m.line));
    }
  });
  vscode.postMessage({ type: 'ready' });
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
        { webviewOptions: { retainContextWhenHidden: true } }
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
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(
        CommonMarkPreviewProviderImpl.viewType,
        new CommonMarkPreviewProviderImpl(context),
        { webviewOptions: { retainContextWhenHidden: true } }
      ),
      openCmd
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
async function openWithCustomEditor(uri: vscode.Uri | undefined, viewType: string): Promise<void> {
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
  const target = preview
    ? uri.with({ query: `commonmarkPreview=${Date.now()}` })
    : uri;

  // Decide where to open the preview. If the source file is already open in a
  // text editor, open the preview to its right (side-by-side). If the file is
  // NOT open yet, opening with ViewColumn.Beside would leave an empty column on
  // the left, so open it in the active column instead. The unique query makes
  // VS Code treat each invocation as a brand new resource so an additional
  // parallel window is opened every time it is already visible.
  let column: vscode.ViewColumn | undefined;
  if (preview) {
    const base = uri.with({ query: "" }).toString();
    const alreadyOpen = vscode.window.visibleTextEditors.some(
      (ed) => ed.document.uri.with({ query: "" }).toString() === base
    );
    column = alreadyOpen ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    target,
    viewType,
    column
  );
}
