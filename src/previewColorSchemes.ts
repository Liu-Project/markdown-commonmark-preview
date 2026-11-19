import * as vscode from "vscode";
import { localize } from "./nls";

/**
 * Preview-only color scheme.
 *
 * This never changes `workbench.colorTheme`; it only changes the colors used
 * by the Markdown preview webview.
 */
export type PreviewColorScheme = "auto" | "light" | "dark";

export const PREVIEW_COLOR_SCHEME_SETTING = "preview.colorScheme";

const COLOR_SCHEME_ORDER: readonly PreviewColorScheme[] = ["auto", "light", "dark"];

/**
 * Reads the configured preview color scheme.
 * Unknown values fall back to "auto" so a hand-edited settings.json can never
 * put the preview into an unsupported state.
 */
export function getPreviewColorScheme(): PreviewColorScheme {
    const value = vscode.workspace
        .getConfiguration("markdown-commonmark-preview")
        .get<string>(PREVIEW_COLOR_SCHEME_SETTING, "auto");
    return value === "light" || value === "dark" ? value : "auto";
}

/** Whether the real VS Code theme is dark (including high-contrast dark). */
export function isActualDark(theme: vscode.ColorTheme): boolean {
    return theme.kind === vscode.ColorThemeKind.Dark
        || theme.kind === vscode.ColorThemeKind.HighContrast;
}

/**
 * Resolves the effective preview darkness.
 *
 * "auto" follows the real VS Code theme; "light" / "dark" force the preview
 * to the corresponding reference theme regardless of the real theme.
 */
export function isEffectiveDark(
    scheme: PreviewColorScheme,
    actual: vscode.ColorTheme
): boolean {
    if (scheme === "light") {
        return false;
    }
    if (scheme === "dark") {
        return true;
    }
    return isActualDark(actual);
}

/**
 * Persists the next value at the scope that currently defines the setting.
 *
 * Writing to Global unconditionally would be a no-op when a workspace override
 * exists, because the override has higher precedence. `preview.colorScheme` is
 * window-scoped, so only Global and Workspace can define it; workspace-folder
 * writes are rejected by VS Code.
 */
async function updatePreviewColorScheme(next: PreviewColorScheme): Promise<void> {
    const section = "markdown-commonmark-preview";
    const config = vscode.workspace.getConfiguration(section);
    const inspected = config.inspect<PreviewColorScheme>(PREVIEW_COLOR_SCHEME_SETTING);

    if (inspected?.workspaceValue !== undefined) {
        await config.update(PREVIEW_COLOR_SCHEME_SETTING, next, vscode.ConfigurationTarget.Workspace);
        return;
    }

    await config.update(PREVIEW_COLOR_SCHEME_SETTING, next, vscode.ConfigurationTarget.Global);
}

/** Cycles auto -> light -> dark -> auto and persists the result. */
export async function togglePreviewColorScheme(): Promise<void> {
    const current = getPreviewColorScheme();
    const next = COLOR_SCHEME_ORDER[
        (COLOR_SCHEME_ORDER.indexOf(current) + 1) % COLOR_SCHEME_ORDER.length
    ];
    try {
        await updatePreviewColorScheme(next);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(localize("ui.preview.colorScheme.updateFailed", message));
    }
}

/**
 * Theme-dependent `--vscode-*` variables referenced by the preview.
 *
 * Values were captured from VS Code 1.138.0 with the default Light+ / Dark+
 * themes. They are applied with `!important` inside the preview webview so
 * they override the inline variables that the webview host injects from the
 * real workbench theme.
 *
 * `initial` emulates a variable that the reference theme does not define, so
 * `var(--vscode-x, fallback)` behaves exactly like it does after a real theme
 * switch (the fallback is used).
 */
export const PREVIEW_COLOR_SCHEME_VARIABLES: Record<
    "light" | "dark",
    Record<string, string>
> = {
    light: {
        "--vscode-button-background": "#007acc",
        "--vscode-button-foreground": "#ffffff",
        "--vscode-chart-line": "#236b8e",
        "--vscode-charts-blue": "#0063d3",
        "--vscode-charts-foreground": "#616161",
        "--vscode-charts-green": "#388a34",
        "--vscode-charts-lines": "rgba(97, 97, 97, 0.5)",
        "--vscode-charts-orange": "rgba(234, 92, 0, 0.33)",
        "--vscode-charts-purple": "#652d90",
        "--vscode-charts-red": "#e51400",
        "--vscode-charts-yellow": "#bf8803",
        "--vscode-contrastBorder": "initial",
        "--vscode-diffEditor-insertedTextBackground": "rgba(156, 204, 44, 0.25)",
        "--vscode-diffEditor-insertedTextBorder": "initial",
        "--vscode-diffEditor-removedTextBackground": "rgba(255, 0, 0, 0.2)",
        "--vscode-diffEditor-removedTextBorder": "initial",
        "--vscode-diffEditorGutter-insertedLineBackground": "initial",
        "--vscode-diffEditorGutter-removedLineBackground": "initial",
        "--vscode-editor-background": "#ffffff",
        "--vscode-editor-findMatchBackground": "#a8ac94",
        "--vscode-editor-findMatchHighlightBackground": "rgba(234, 92, 0, 0.33)",
        "--vscode-editor-foreground": "#000000",
        "--vscode-editorError-background": "initial",
        "--vscode-editorError-foreground": "#e51400",
        "--vscode-editorGutter-modifiedBackground": "#2090d3",
        "--vscode-editorWidget-background": "#f3f3f3",
        "--vscode-editorWidget-border": "rgba(97, 97, 97, 0.2)",
        "--vscode-focusBorder": "#0090f1",
        "--vscode-foreground": "#616161",
        "--vscode-input-background": "#ffffff",
        "--vscode-input-border": "initial",
        "--vscode-input-foreground": "#616161",
        "--vscode-inputValidation-errorBackground": "#f2dede",
        "--vscode-keybindingLabel-background": "rgba(221, 221, 221, 0.4)",
        "--vscode-keybindingLabel-border": "rgba(204, 204, 204, 0.4)",
        "--vscode-keybindingLabel-bottomBorder": "rgba(187, 187, 187, 0.4)",
        "--vscode-keybindingLabel-foreground": "#555555",
        "--vscode-scrollbarSlider-activeBackground": "rgba(0, 0, 0, 0.6)",
        "--vscode-scrollbarSlider-background": "rgba(100, 100, 100, 0.4)",
        "--vscode-scrollbarSlider-hoverBackground": "rgba(100, 100, 100, 0.7)",
        "--vscode-testing-iconPassed": "#73c991",
        "--vscode-textBlockQuote-background": "#f2f2f2",
        "--vscode-textBlockQuote-border": "rgba(0, 122, 204, 0.5)",
        "--vscode-textCodeBlock-background": "rgba(220, 220, 220, 0.4)",
        "--vscode-textLink-activeForeground": "#006ab1",
        "--vscode-textLink-foreground": "#006ab1",
        "--vscode-textPreformat-background": "rgba(0, 0, 0, 0.1)",
        "--vscode-textPreformat-foreground": "#a31515",
        "--vscode-toolbar-activeBackground": "rgba(166, 166, 166, 0.31)",
        "--vscode-toolbar-hoverBackground": "rgba(184, 184, 184, 0.31)",
        "--vscode-widget-border": "#d4d4d4",
        "--vscode-widget-shadow": "rgba(0, 0, 0, 0.16)",
    },
    dark: {
        "--vscode-button-background": "#0e639c",
        "--vscode-button-foreground": "#ffffff",
        "--vscode-chart-line": "#236b8e",
        "--vscode-charts-blue": "#59a4f9",
        "--vscode-charts-foreground": "#cccccc",
        "--vscode-charts-green": "#89d185",
        "--vscode-charts-lines": "rgba(204, 204, 204, 0.5)",
        "--vscode-charts-orange": "rgba(234, 92, 0, 0.33)",
        "--vscode-charts-purple": "#b180d7",
        "--vscode-charts-red": "#f14c4c",
        "--vscode-charts-yellow": "#cca700",
        "--vscode-contrastBorder": "initial",
        "--vscode-diffEditor-insertedTextBackground": "rgba(156, 204, 44, 0.2)",
        "--vscode-diffEditor-insertedTextBorder": "initial",
        "--vscode-diffEditor-removedTextBackground": "rgba(255, 0, 0, 0.2)",
        "--vscode-diffEditor-removedTextBorder": "initial",
        "--vscode-diffEditorGutter-insertedLineBackground": "initial",
        "--vscode-diffEditorGutter-removedLineBackground": "initial",
        "--vscode-editor-background": "#1e1e1e",
        "--vscode-editor-findMatchBackground": "#515c6a",
        "--vscode-editor-findMatchHighlightBackground": "rgba(234, 92, 0, 0.33)",
        "--vscode-editor-foreground": "#d4d4d4",
        "--vscode-editorError-background": "initial",
        "--vscode-editorError-foreground": "#f14c4c",
        "--vscode-editorGutter-modifiedBackground": "#1b81a8",
        "--vscode-editorWidget-background": "#252526",
        "--vscode-editorWidget-border": "rgba(204, 204, 204, 0.2)",
        "--vscode-focusBorder": "#007fd4",
        "--vscode-foreground": "#cccccc",
        "--vscode-input-background": "#3c3c3c",
        "--vscode-input-border": "initial",
        "--vscode-input-foreground": "#cccccc",
        "--vscode-inputValidation-errorBackground": "#5a1d1d",
        "--vscode-keybindingLabel-background": "rgba(128, 128, 128, 0.17)",
        "--vscode-keybindingLabel-border": "rgba(51, 51, 51, 0.6)",
        "--vscode-keybindingLabel-bottomBorder": "rgba(68, 68, 68, 0.6)",
        "--vscode-keybindingLabel-foreground": "#cccccc",
        "--vscode-scrollbarSlider-activeBackground": "rgba(191, 191, 191, 0.4)",
        "--vscode-scrollbarSlider-background": "rgba(121, 121, 121, 0.4)",
        "--vscode-scrollbarSlider-hoverBackground": "rgba(100, 100, 100, 0.7)",
        "--vscode-testing-iconPassed": "#73c991",
        "--vscode-textBlockQuote-background": "#222222",
        "--vscode-textBlockQuote-border": "rgba(0, 122, 204, 0.5)",
        "--vscode-textCodeBlock-background": "rgba(10, 10, 10, 0.4)",
        "--vscode-textLink-activeForeground": "#3794ff",
        "--vscode-textLink-foreground": "#3794ff",
        "--vscode-textPreformat-background": "rgba(255, 255, 255, 0.1)",
        "--vscode-textPreformat-foreground": "#d7ba7d",
        "--vscode-toolbar-activeBackground": "rgba(99, 102, 103, 0.31)",
        "--vscode-toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
        "--vscode-widget-border": "#303031",
        "--vscode-widget-shadow": "rgba(0, 0, 0, 0.36)",
    },
};

/**
 * Renders the palette overrides for both reference themes.
 *
 * The rules only match when the webview root carries the matching
 * `data-preview-theme` attribute, which is only set while the user forces a
 * preview color scheme. In "auto" mode the attribute is absent and the real
 * VS Code theme variables remain untouched.
 */
export function renderPreviewColorSchemeCss(): string {
    const render = (
        mode: "light" | "dark",
        variables: Record<string, string>
    ): string => {
        const declarations = Object.entries(variables)
            .map(([name, value]) => `${name}:${value} !important;`)
            .join("");
        return `html[data-preview-theme="${mode}"]{${declarations}}`;
    };
    return `${render("light", PREVIEW_COLOR_SCHEME_VARIABLES.light)}
${render("dark", PREVIEW_COLOR_SCHEME_VARIABLES.dark)}`;
}
