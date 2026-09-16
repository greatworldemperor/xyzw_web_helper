#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(process.argv[2] || 'scripts/7.7.12.runtime-traced.js');
const outputDir = path.resolve(process.argv[3] || 'scripts/7.7.12.runtime-traced-parts');
const chunkBase64Size = Number(process.argv[4] || 32768);
const source = fs.readFileSync(sourcePath);
const encoded = source.toString('base64');
const id = `xyzw-7.7.12-runtime-traced-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
const total = Math.ceil(encoded.length / chunkBase64Size);

if (!Number.isInteger(chunkBase64Size) || chunkBase64Size < 4096) {
  throw new Error('chunk size must be an integer >= 4096 base64 characters');
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

function partSource(index, payload) {
  const name = `7.7.12.runtime-traced.part-${String(index + 1).padStart(4, '0')}.js`;
  return `// ==UserScript==
// @name         7.7.12 Runtime Tracer Part ${index + 1}/${total}
// @namespace    xyzw-deobfuscator
// @version      1.0.0
// @description  Chunk ${index + 1} of the runtime decoder tracer. Import all parts; order does not matter.
// @match        *://*/*
// @run-at       document-end
// ==/UserScript==
(function (global) {
  'use strict';
  var id = ${JSON.stringify(id)};
  var state = global.__xyzwRuntimeTracerParts;
  if (!state || state.id !== id) {
    state = global.__xyzwRuntimeTracerParts = {
      id: id,
      total: ${total},
      parts: Object.create(null),
      received: 0,
      started: false,
      sourceBytes: ${source.length},
      error: ''
    };
  }
  if (!state.parts[${index}]) {
    state.parts[${index}] = ${JSON.stringify(payload)};
    state.received += 1;
  }
  if (state.started || state.received !== state.total) return;
  state.started = true;
  try {
    var encoded = '';
    for (var partIndex = 0; partIndex < state.total; partIndex += 1) {
      encoded += state.parts[partIndex];
    }
    var binary = atob(encoded);
    var bytes = new Uint8Array(binary.length);
    for (var byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
      bytes[byteIndex] = binary.charCodeAt(byteIndex);
    }
    var script = document.createElement('script');
    script.setAttribute('data-xyzw-runtime-tracer', id);
    script.textContent = new TextDecoder('utf-8').decode(bytes);
    (document.head || document.documentElement).appendChild(script);
    state.executedAt = new Date().toISOString();
  } catch (error) {
    state.error = error && error.stack ? error.stack : String(error);
    console.error('[XYZW tracer chunks] 执行失败', error);
  }
})(typeof globalThis === 'object' ? globalThis : window);
`;
}

const files = [];
for (let index = 0; index < total; index += 1) {
  const payload = encoded.slice(index * chunkBase64Size, (index + 1) * chunkBase64Size);
  const fileName = `7.7.12.runtime-traced.part-${String(index + 1).padStart(4, '0')}.js`;
  fs.writeFileSync(path.join(outputDir, fileName), partSource(index, payload), 'utf8');
  files.push({ fileName, bytes: fs.statSync(path.join(outputDir, fileName)).size });
}

const manifest = {
  id,
  source: path.basename(sourcePath),
  sourceBytes: source.length,
  encodedBytes: Buffer.byteLength(encoded),
  chunkBase64Size,
  total,
  files,
  importOrder: 'arbitrary',
  executeWhen: 'all parts are present in the same page',
};
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'README.txt'), [
  '7.7.12 runtime tracer chunks',
  '',
  `Parts: ${total}`,
  `Maximum base64 payload per part: ${chunkBase64Size}`,
  'Import every .js part into the Snowflake script tool. Selection order does not matter.',
  'The complete tracer executes automatically after the last part is imported.',
  'Use the game page with ?wss-sandbox=1&deobfuscator-trace=1.',
  'Do not use a real account action; all WSS sends must remain blocked.',
  '',
].join('\n'), 'utf8');

console.log(JSON.stringify({ outputDir, ...manifest }));