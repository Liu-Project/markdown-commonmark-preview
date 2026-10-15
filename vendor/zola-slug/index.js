"use strict";
const fs = require("fs");
const path = require("path");
const { TextEncoder, TextDecoder } = require("util");

let instancePromise;

function getInstance() {
  if (!instancePromise) {
    instancePromise = (async () => {
      const bytes = fs.readFileSync(path.join(__dirname, "zola_slug_bg.wasm"));
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })();
  }
  return instancePromise;
}

/**
 * slugify a string using the zola-slug wasm module
 * @param {string} text
 * @returns {string}
 */
async function slugify(text) {
  const e = await getInstance();
  const { memory, __wbindgen_add_to_stack_pointer } = e;
  const malloc = e.__wbindgen_export_0;
  const enc = new TextEncoder();
  const data = enc.encode(String(text));
  const ptr = (malloc(data.length, 1) >>> 0);
  new Uint8Array(memory.buffer).set(data, ptr);
  const stackPtr = __wbindgen_add_to_stack_pointer(-16);
  const view = new DataView(memory.buffer);
  e.slugify(stackPtr, ptr, data.length);
  const r0 = view.getInt32(stackPtr + 0, true);
  const r1 = view.getInt32(stackPtr + 4, true);
  const dec = new TextDecoder();
  const result = dec.decode(new Uint8Array(memory.buffer, r0, r1));
  __wbindgen_add_to_stack_pointer(16);
  return result;
}

module.exports = { slugify };
