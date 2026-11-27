// Mermaid block support for markdown-it.
//
// Verbatim port of VS Code's built-in mermaid-markdown-features
// (vscode/extensions/mermaid-markdown-features/src/markdownMermaid/markdownIt.ts):
//   - ```` ```mermaid ```` fenced blocks are emitted as `<pre class="mermaid">`
//     through the `highlight` hook, so the actual SVG rendering happens in the
//     webview (which derives its colours from the active VS Code theme).
//   - `:::mermaid` container blocks are emitted as `<div class="mermaid">`.
//
// The webview renders every `.mermaid` element with
// `mermaid.initialize({ theme: 'base', themeVariables: ... })`.

import MarkdownIt = require("markdown-it");

const mermaidLanguageId = "mermaid";
const containerTokenName = "mermaidContainer";

const minMarkers = 3;
const markerStr = ":";
const markerChar = markerStr.charCodeAt(0);
const markerLen = markerStr.length;

export function extendMarkdownItWithMermaid(md: MarkdownIt): MarkdownIt {
	md.use((md: MarkdownIt) => {
		function container(state: MarkdownIt.StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
			let pos: number;
			let autoClosed = false;
			let start = state.bMarks[startLine] + state.tShift[startLine];
			let max = state.eMarks[startLine];

			if (markerChar !== state.src.charCodeAt(start)) {
				return false;
			}

			for (pos = start + 1; pos <= max; pos++) {
				if (markerStr[(pos - start) % markerLen] !== state.src[pos]) {
					break;
				}
			}

			const markerCount = Math.floor((pos - start) / markerLen);
			if (markerCount < minMarkers) {
				return false;
			}
			pos -= (pos - start) % markerLen;

			const markup = state.src.slice(start, pos);
			const params = state.src.slice(pos, max);
			if (params.trim().split(" ")[0].toLowerCase() !== mermaidLanguageId) {
				return false;
			}

			if (silent) {
				return true;
			}

			let nextLine = startLine;

			for (; ;) {
				nextLine++;
				if (nextLine >= endLine) {
					break;
				}

				start = state.bMarks[nextLine] + state.tShift[nextLine];
				max = state.eMarks[nextLine];

				if (start < max && state.sCount[nextLine] < state.blkIndent) {
					break;
				}

				if (markerChar !== state.src.charCodeAt(start)) {
					continue;
				}

				if (state.sCount[nextLine] - state.blkIndent >= 4) {
					continue;
				}

				for (pos = start + 1; pos <= max; pos++) {
					if (markerStr[(pos - start) % markerLen] !== state.src[pos]) {
						break;
					}
				}

				if (Math.floor((pos - start) / markerLen) < markerCount) {
					continue;
				}

				pos -= (pos - start) % markerLen;
				pos = state.skipSpaces(pos);

				if (pos < max) {
					continue;
				}

				autoClosed = true;
				break;
			}

			const oldParent = state.parentType;
			const oldLineMax = state.lineMax;
			state.parentType = "container" as MarkdownIt.StateBlock.ParentType;

			state.lineMax = nextLine;

			const containerToken = state.push(containerTokenName, "div", 1);
			containerToken.markup = markup;
			containerToken.block = true;
			containerToken.info = params;
			containerToken.map = [startLine, nextLine];
			containerToken.content = state.getLines(startLine + 1, nextLine, state.blkIndent, true);

			state.parentType = oldParent;
			state.lineMax = oldLineMax;
			state.line = nextLine + (autoClosed ? 1 : 0);

			return true;
		}

		md.block.ruler.before("fence", containerTokenName, container, {
			alt: ["paragraph", "reference", "blockquote", "list"]
		});
		md.renderer.rules[containerTokenName] = (tokens: MarkdownIt.Token[], idx: number) => {
			const token = tokens[idx];
			const src = token.content;
			return `<div class="${mermaidLanguageId}">${preProcess(src)}</div>`;
		};
	});

	const highlight = md.options.highlight;
	md.options.highlight = (code: string, lang: string, attrs: string) => {
		if (lang && lang.toLowerCase() === mermaidLanguageId) {
			return `<pre class="${mermaidLanguageId}" style="all: unset;">${preProcess(code)}</pre>`;
		}
		return highlight ? highlight(code, lang, attrs) : code;
	};

	return md;
}

function preProcess(source: string): string {
	return source
		.replace(/\u00A0/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n+$/, "")
		.trimStart();
}
