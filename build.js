const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Bundle extension (inline zola-slug so it is self-contained)
execSync("npx esbuild out/extension.js --bundle --platform=node --external:vscode --format=cjs --outfile=dist/extension.js", { stdio: "inherit" });
execSync("npx esbuild out/markdown-it-plugin-provider.js --bundle --platform=node --external:vscode --format=cjs --outfile=dist/markdownItPlugins.bundle.js", { stdio: "inherit" });

// Copy zola-slug wasm into dist/ so the inlined module (whose __dirname becomes dist/) can find it.
const wasmSrc = path.join(__dirname, "node_modules", "zola-slug", "zola_slug_bg.wasm");
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, path.join(__dirname, "dist", "zola_slug_bg.wasm"));
  console.log("copied zola_slug_bg.wasm -> dist/");
}
console.log("build done");
