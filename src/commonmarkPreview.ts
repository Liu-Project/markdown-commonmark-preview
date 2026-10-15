import * as vscode from "vscode";

/**
 * Runtime preview contributions.
 *
 * The CommonMark-style preview is primarily wired through package.json:
 *  - `markdown.previewStyles`   -> media/commonmark-preview.css (CommonMark github theme + callouts + diagrams)
 *  - `markdown.markdownItPlugins` -> dist/markdownItPlugins.bundle.js (math, diagrams, task lists, highlight)
 *  - `markdown.previewScripts`  -> media/mermaid.min.js + media/preview.js (render diagrams)
 *
 * This hook only registers commands that let users pick the CommonMark theme for the preview.
 */
export function activatePreviewContributions(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("markdown-commonmark-preview.setTheme", async () => {
            const current = vscode.workspace.getConfiguration("markdown-commonmark-preview").get<string>("theme", "github");
            const themes = ["github"];
            const picked = await vscode.window.showQuickPick(themes, {
                placeHolder: `当前主题: ${current}`,
                title: "选择 CommonMark 预览主题"
            });
            if (picked) {
                await vscode.workspace.getConfiguration("markdown-commonmark-preview").update("theme", picked, vscode.ConfigurationTarget.Global);
            }
        })
    );
}
