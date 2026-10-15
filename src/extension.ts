// Based on Markdown All in One
// <https://github.com/yzhang-gh/vscode-markdown>
// MIT License, Copyright (c) 2017 张宇

import { ExtensionContext, languages, window, workspace } from 'vscode';
import { configManager } from "./configuration/manager";
import { contextServiceManager } from "./editor-context-service/manager"
import { decorationManager } from "./theming/decorationManager";
import * as completion from './completion';
import * as formatting from './formatting';
import * as listEditing from './listEditing';
import { commonMarkEngine, mdEngine } from "./markdownEngine";
import { extendMarkdownIt } from "./markdown-it-plugin-provider";
import { config as configNls } from './nls';
import * as preview from './preview';
import * as print from './print';
import * as tableFormatter from './tableFormatter';
import * as toc from './toc';
import { importZolaSlug } from './util/slugify';
import { CommonMarkEditorProvider, CommonMarkPreviewProvider } from './commonmarkCustomEditors';
import { activatePreviewContributions } from './commonmarkPreview';

export function activate(context: ExtensionContext) {
    configNls({ extensionContext: context });

    context.subscriptions.push(
        configManager, contextServiceManager, decorationManager, commonMarkEngine, mdEngine
    );

    // CommonMark-style preview contributions (preview styles / scripts are declared in package.json;
    // this hook is for anything else we need at runtime).
    activatePreviewContributions(context);

    // Register .md custom editors (visible in "Open With" / default editor picker)
    context.subscriptions.push(CommonMarkEditorProvider.register(context));
    context.subscriptions.push(CommonMarkPreviewProvider.register(context));

    // wasm modules need to be imported asynchronously (or any modules relying on them synchronously need to be imported asynchronously)
    importZolaSlug().then(() => {
        // we need to wait for the wasm module to be loaded before we can use it, it should only take a few milliseconds
        // if we move the activateMdExt function outside of this promise, slugify might be called before the wasm module has loaded which will cause it to fail
        activateMdExt(context);
    });

    return { extendMarkdownIt };
}

function activateMdExt(context: ExtensionContext) {
    // Context services
    contextServiceManager.activate(context);
    // Override `Enter`, `Tab` and `Backspace` keys
    listEditing.activate(context);
    // Shortcuts
    formatting.activate(context);
    // Toc
    toc.activate(context);
    // Images paths and math commands completions
    completion.activate(context);
    // Print to PDF
    print.activate(context);
    // Table formatter
    tableFormatter.activate(context);
    // Auto show preview to side
    preview.activate(context);

    // Allow `*` in word pattern for quick styling (toggle bold/italic without selection)
    // original https://github.com/microsoft/vscode/blob/3e5c7e2c570a729e664253baceaf443b69e82da6/extensions/markdown-basics/language-configuration.json#L55
    languages.setLanguageConfiguration('markdown', {
        wordPattern: /([*_]{1,2}|~~|`+)?[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+(_+[\p{Alphabetic}\p{Number}\p{Nonspacing_Mark}]+)*\1/gu
    });
}

export function deactivate() { }
