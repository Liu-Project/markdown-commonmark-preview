// Based on Markdown All in One
// <https://github.com/yzhang-gh/vscode-markdown>
// MIT License, Copyright (c) 2017 张宇

import * as fs from "fs";
import * as path from 'path';
import { commands, ExtensionContext, TextDocument, Uri, window, workspace } from 'vscode';
import { encodeHTML } from 'entities';
import { localize } from './nls';
import { mdEngine } from "./markdownEngine";
import { isMdDocument } from "./util/generic";
import {
    convertMdLinksToHtml,
    extractDocumentTitle,
    getExportThemeVariableStyles,
    getPreviewExtensionScripts,
    getPreviewExtensionStyles,
    getPrintStyles,
    hasMathEnv,
    processDocumentImages
} from './export';

export function activate(context: ExtensionContext) {
    context.subscriptions.push(
        commands.registerCommand('markdown-commonmark-preview.printToHtml', () => { print('html'); }),
        commands.registerCommand('markdown-commonmark-preview.printToHtmlBatch', () => { batchPrint(); }),
        workspace.onDidSaveTextDocument(onDidSave)
    );
}

export function deactivate() { }

function onDidSave(doc: TextDocument) {
    if (
        doc.languageId === 'markdown'
        && workspace.getConfiguration('markdown-commonmark-preview.print', doc.uri).get<boolean>('onFileSave')
    ) {
        print('html');
    }
}

async function print(type: string, uri?: Uri, outFolder?: string) {
    const editor = window.activeTextEditor;

    if (!editor || !isMdDocument(editor?.document)) {
        window.showErrorMessage(localize("ui.general.messageNoValidMarkdownFile"));
        return;
    }

    const doc = uri ? await workspace.openTextDocument(uri) : editor.document;
    if (doc.isDirty || doc.isUntitled) {
        doc.save();
    }

    const statusBarMessage = window.setStatusBarMessage("$(sync~spin) " + localize("ui.exporting.messageExportingInProgress", path.basename(doc.fileName), type.toUpperCase()));

    if (outFolder && !fs.existsSync(outFolder)) {
        fs.mkdirSync(outFolder, { recursive: true });
    }

    /**
     * Modified from <https://github.com/Microsoft/vscode/tree/master/extensions/markdown>
     * src/previewContentProvider MDDocumentContentProvider provideTextDocumentContent
     */
    let outPath = outFolder ? path.join(outFolder, path.basename(doc.fileName)) : doc.fileName;
    outPath = outPath.replace(/\.\w+?$/, `.${type}`);
    outPath = outPath.replace(/^([cdefghij]):\\/, function (_, p1: string) {
        return `${p1.toUpperCase()}:\\`; // Capitalize drive letter
    });
    if (!outPath.endsWith(`.${type}`)) {
        outPath += `.${type}`;
    }

    //// Determine document title.
    // 1. If the document begins with a comment like `<!-- title: Document Title -->`, use it. Empty title is not allow here. (GitHub #506)
    // 2. Else, find the first ATX heading, and use it.
    const title = extractDocumentTitle(doc);

    //// Render body HTML.
    let body: string = await mdEngine.render(doc.getText(), workspace.getConfiguration('markdown.preview', doc.uri));

    //// Image paths
    const config = workspace.getConfiguration('markdown-commonmark-preview', doc.uri);
    body = processDocumentImages(doc, body);

    //// Convert `.md` links to `.html` by default (#667, #1324, #1347)
    body = convertMdLinksToHtml(body);

    const hasMath = hasMathEnv(doc.getText());
    const extensionStyles = await getPreviewExtensionStyles();
    const extensionScripts = await getPreviewExtensionScripts();
    const includeVscodeStyles = config.get<boolean>('print.includeVscodeStylesheets')!;
    const pureHtml = config.get<boolean>('print.pureHtml')!;
    const themeKind = config.get<string>('print.theme');
    const themeClass = themeKind === 'light' ? 'vscode-light' : themeKind === 'dark' ? 'vscode-dark' : '';
    const themeVarsCss = themeClass ? getExportThemeVariableStyles(themeClass === 'vscode-dark') : '';

    let html = body;
    if (!pureHtml) {
        html = `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${title ? encodeHTML(title) : ''}</title>
            ${themeVarsCss}
            ${extensionStyles}
            ${getPrintStyles(doc.uri, hasMath, includeVscodeStyles)}
        </head>
        <body class="vscode-body ${themeClass}">
            ${body}
            ${hasMath ? '<script async src="https://cdn.jsdelivr.net/npm/katex-copytex@latest/dist/katex-copytex.min.js"></script>' : ''}
            ${extensionScripts}
        </body>
        </html>`;
    }

    switch (type) {
        case 'html':
            fs.writeFile(outPath, html, 'utf-8', function (err) {
                if (err) { console.log(err); }
            });
            break;
        case 'pdf':
            break;
    }

    // Hold the message for extra 500ms, in case the operation finished very fast.
    setTimeout(() => statusBarMessage.dispose(), 500);
}

function batchPrint() {
    const doc = window.activeTextEditor?.document;
    // @ts-ignore Needs refactoring.
    const root = workspace.getWorkspaceFolder(doc.uri).uri;
    window.showOpenDialog({ defaultUri: root, openLabel: 'Select source folder', canSelectFiles: false, canSelectFolders: true }).then(uris => {
        if (uris && uris.length > 0) {
            const selectedPath = uris[0].fsPath;
            const relPath = path.relative(root.fsPath, selectedPath);

            if (relPath.startsWith('..')) {
                window.showErrorMessage('Cannot use a path outside the current folder');
                return;
            }

            workspace.findFiles((relPath.length > 0 ? relPath + '/' : '') + '**/*.{md}', '{**/node_modules,**/bower_components,**/*.code-search}').then(uris => {
                window.showInputBox({
                    value: selectedPath + path.sep + 'out',
                    valueSelection: [selectedPath.length + 1, selectedPath.length + 4],
                    prompt: 'Please specify an output folder'
                }).then(outFolder => {
                    uris.forEach(uri => {
                        print('html', uri, path.join(outFolder!, path.relative(selectedPath, path.dirname(uri.fsPath))));
                    });
                });
            });
        }
    });
}
