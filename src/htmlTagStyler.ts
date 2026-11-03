// Typora-style HTML tag rendering.
//
// Typora does not let unknown/custom XML tags (e.g. <Schedules>, <PartitionWindow/>)
// be swallowed by the browser: standard HTML tags are still rendered for real,
// while any other tag is shown as low-contrast (grey) text so the raw markup
// stays visible without being intrusive.
//
// This module installs the two markdown-it renderer rules that implement that:
//   - html_inline / html_block whose FIRST tag is a known HTML tag -> rendered as usual.
//   - anything else (custom XML tags, comments, doctype...) -> HTML-escaped and
//     wrapped in <span class="md-html-tag">, styled grey by CSS.
//
// Shared by the custom-editor preview and the VS Code built-in preview.

import MarkdownIt = require("markdown-it");

// HTML5 standard tags that keep real rendering.
const KNOWN_HTML_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base",
  "bdi", "bdo", "blockquote", "body", "br", "button", "canvas", "caption",
  "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del",
  "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img",
  "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map",
  "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol",
  "optgroup", "option", "output", "p", "picture", "pre", "progress", "q",
  "rp", "rt", "ruby", "s", "samp", "script", "search", "section", "select",
  "slot", "small", "source", "span", "strong", "style", "sub", "summary",
  "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th",
  "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
]);

/**
 * Escapes a raw HTML fragment so the browser displays it as plain text.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Returns the first tag name inside an html_inline / html_block token content,
 * or undefined when the content does not start with a tag (comments, doctype...).
 */
function firstTagName(content: string): string | undefined {
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(content);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Installs the Typora-style renderer rules on a markdown-it instance.
 */
export function installHtmlTagStyling(md: MarkdownIt): void {
  const wrap = (rule: string) => {
    const original = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens: any[], idx: number, options: any, env: any, self: any) => {
      const content = tokens[idx].content;
      const name = firstTagName(content);
      if (name !== undefined && KNOWN_HTML_TAGS.has(name)) {
        return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
      }
      return `<span class="md-html-tag">${escapeHtmlText(content)}</span>`;
    };
  };

  wrap("html_inline");
  wrap("html_block");
}
