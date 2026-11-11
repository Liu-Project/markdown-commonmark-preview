// Minimal VS Code API stub used to run the extension's export pipeline in a
// plain Node.js process (for the automated export test report). Not shipped.
'use strict';
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ---- configuration store (mirrors package.json defaults) ----
const DEFAULTS = {
  'markdown-commonmark-preview': {
    'print.imgToBase64': false,
    'print.absoluteImgPath': true,
    'print.includeVscodeStylesheets': true,
    'print.onFileSave': false,
    'print.pureHtml': false,
    'print.theme': 'light',
    'print.validateUrls': true,
    'math.enabled': true,
    'katex.macros': {},
    'toc.slugifyMode': 'github',
    'extraLangIds': [],
    'theme': 'github',
    'showActionButtons': false,
  },
  'markdown-commonmark-preview.print': {
    'imgToBase64': false,
    'absoluteImgPath': true,
    'includeVscodeStylesheets': true,
    'onFileSave': false,
    'pureHtml': false,
    'theme': 'light',
    'validateUrls': true,
  },
  'markdown-commonmark-preview.export': {
    'chromePath': '',
    'headingHierarchy': true,
    'pdfPageSize': 'A4',
    'pdfMargin': '20mm',
  },
  'markdown.preview': {
    'breaks': false,
    'linkify': true,
  },
  'markdown': {
    'styles': [],
    'preview': {},
  },
};

const configStore = JSON.parse(JSON.stringify(DEFAULTS));

function __setConfig(section, key, value) {
  if (!configStore[section]) configStore[section] = {};
  configStore[section][key] = value;
}
function __setConfigDeep(section, value) {
  configStore[section] = JSON.parse(JSON.stringify(value));
}

function makeConfiguration(section, scope) {
  const obj = {};
  obj.get = (key, def) => {
    const s = configStore[section] || {};
    if (key in s) return s[key];
    // fall back to the unscoped commonmark section for dotted keys
    if (section === 'markdown-commonmark-preview' && !(key in s)) {
      return undefined;
    }
    return def;
  };
  // property access (e.g. config['styles'], config['preview'])
  Object.defineProperty(obj, 'style', { enumerable: false, get: () => undefined });
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const s = configStore[section];
      if (s && prop in s) return s[prop];
      return undefined;
    },
  });
}

// ---- Uri ----
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
  static file(fsPath) { return new Uri(fsPath); }
  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath || base, ...parts));
  }
  toString() { return 'file://' + this.fsPath; }
  with() { return this; }
}

// ---- events ----
function makeEmitter() {
  const listeners = [];
  return {
    event: (fn) => { listeners.push(fn); return { dispose: () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } }; },
    fire: (data) => { for (const fn of listeners.slice()) { try { fn(data); } catch (e) { console.error('event listener error', e); } } },
    dispose: () => { listeners.length = 0; },
  };
}

// ---- fake markdown extension contribution (mirrors this extension's package.json) ----
const pkg = require(path.join(REPO_ROOT, 'package.json'));
const markdownContribution = {
  id: (pkg.publisher || 'test') + '.' + pkg.name,
  packageJSON: {
    name: pkg.name,
    version: pkg.version,
    publisher: pkg.publisher,
    engines: pkg.engines,
    contributes: {
      'markdown.previewStyles': [
        './media/checkbox.css',
        './media/katex/katex.min.css',
        './media/hljs/github.min.css',
        './media/commonmark-style.css',
      ],
      'markdown.previewScripts': [
        './media/mermaid.min.js',
        './media/preview.js',
      ],
      // NOTE: markdownItPlugins intentionally omitted here; the engine applies
      // this extension's plugins directly (markdownEngine.newEngine -> extendMarkdownIt).
    },
  },
  extensionUri: Uri.file(REPO_ROOT),
  activate: async () => ({}),
};

// ---- window/workspace/commands state ----
const state = {
  activeEditor: undefined,
  messages: [],
  statusBar: { text: '', disposed: false, dispose() { this.disposed = true; } },
  commands: {},
};

const workspace = {
  getConfiguration: (section, scope) => makeConfiguration(section || '', scope),
  onDidCloseTextDocument: () => ({ dispose() { } }),
  onDidChangeConfiguration: () => ({ dispose() { } }),
  onDidSaveTextDocument: () => ({ dispose() { } }),
  onDidChangeTextDocument: () => ({ dispose() { } }),
  getWorkspaceFolder: () => undefined,
  openTextDocument: async (uri) => {
    const fsPath = uri && uri.fsPath ? uri.fsPath : uri;
    const text = require('fs').readFileSync(fsPath, 'utf8');
    return makeTextDocument(fsPath, text);
  },
  textDocuments: [],
  findFiles: async () => [],
};

const windowStub = {
  showErrorMessage: (msg) => { state.messages.push({ level: 'error', msg }); return Promise.resolve(); },
  showWarningMessage: (msg) => { state.messages.push({ level: 'warning', msg }); return Promise.resolve(); },
  showInformationMessage: (msg) => { state.messages.push({ level: 'info', msg }); return Promise.resolve(); },
  setStatusBarMessage: (text) => { state.statusBar.text = text; state.statusBar.disposed = false; return state.statusBar; },
  showQuickPick: async (items) => (items && items.length ? items[0] : undefined),
  showOpenDialog: async () => undefined,
  showInputBox: async () => undefined,
  get activeTextEditor() { return state.activeEditor; },
};

const commands = {
  registerCommand: (id, fn) => { state.commands[id] = fn; return { dispose() { delete state.commands[id]; } }; },
  executeCommand: async (id, ...args) => {
    if (!state.commands[id]) throw new Error('command not registered: ' + id);
    return state.commands[id](...args);
  },
};

function makeTextDocument(fsPath, text) {
  const lines = text.split(/\n|\r/g);
  return {
    uri: Uri.file(fsPath),
    fileName: fsPath,
    languageId: 'markdown',
    isDirty: false,
    isUntitled: false,
    version: 1,
    lineCount: lines.length,
    lineAt: (n) => ({ text: lines[n] || '', range: {} }),
    getText: () => text,
    save: async () => true,
  };
}

function makeEditor(doc) {
  return { document: doc, viewColumn: 1, visibleRanges: [{ start: { line: 0, character: 0 } }] };
}

module.exports = {
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  EventEmitter: makeEmitter,
  Uri,
  workspace,
  window: windowStub,
  commands,
  extensions: {
    all: [markdownContribution],
    onDidChange: () => ({ dispose() { } }),
  },
  Disposable: { from: (...d) => ({ dispose: () => d.forEach((x) => x && x.dispose()) }) },
  // test helpers
  __test: { state, configStore, DEFAULTS, __setConfig, __setConfigDeep, makeTextDocument, makeEditor, Uri },
};
