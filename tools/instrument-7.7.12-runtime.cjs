#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('../node_modules/.pnpm/acorn@8.16.0/node_modules/acorn');
const escodegen = require('../node_modules/.pnpm/escodegen@2.1.0/node_modules/escodegen/escodegen.js');

const sourcePath = path.resolve(process.argv[2] || 'scripts/7.7.12.js');
const outputPath = path.resolve(process.argv[3] || 'scripts/7.7.12.runtime-traced.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const decoderNames = new Set(['a0D', 'a0w']);
const traceFunction = '__xyzwRuntimeTrace';
const traceCallFunction = '__xyzwRuntimeTraceCall';
const traceArgs = '__xyzwTraceArgs';
let instrumented = [];

function hasDirectDecoderCall(node, root) {
  if (!node || typeof node !== 'object') return false;
  if (node !== root && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return false;
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && decoderNames.has(node.callee.name)) return true;
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value) && value.some((item) => hasDirectDecoderCall(item, root))) return true;
    if (value && typeof value.type === 'string' && hasDirectDecoderCall(value, root)) return true;
  }
  return false;
}

function identifier(name) {
  return { type: 'Identifier', name };
}

function literal(value) {
  return { type: 'Literal', value, raw: JSON.stringify(value) };
}

function member(object, property) {
  return {
    type: 'MemberExpression',
    computed: true,
    object: identifier(object),
    property: literal(property),
  };
}

function traceCall(name, originalReturn) {
  return {
    type: 'ConditionalExpression',
    test: {
      type: 'LogicalExpression',
      operator: '&&',
      left: {
        type: 'BinaryExpression',
        operator: '!==',
        left: identifier('globalThis'),
        right: identifier('undefined'),
      },
      right: {
        type: 'BinaryExpression',
        operator: '===',
        left: {
          type: 'UnaryExpression',
          operator: 'typeof',
          prefix: true,
          argument: member('globalThis', traceFunction),
        },
        right: literal('function'),
      },
    },
    consequent: {
      type: 'CallExpression',
      callee: member('globalThis', traceFunction),
      arguments: [
        literal(name),
        {
          type: 'MemberExpression',
          computed: true,
          object: identifier(traceArgs),
          property: literal(0),
        },
        {
          type: 'MemberExpression',
          computed: true,
          object: identifier(traceArgs),
          property: literal(1),
        },
        originalReturn,
      ],
    },
    alternate: originalReturn,
  };
}

function traceCallSite(node, name, originalReturn) {
  return {
    type: 'ConditionalExpression',
    test: {
      type: 'BinaryExpression',
      operator: '===',
      left: {
        type: 'UnaryExpression',
        operator: 'typeof',
        prefix: true,
        argument: member('globalThis', traceCallFunction),
      },
      right: literal('function'),
    },
    consequent: {
      type: 'CallExpression',
      callee: member('globalThis', traceCallFunction),
      arguments: [literal(node.start), literal(name), originalReturn],
    },
    alternate: originalReturn,
  };
}

function instrumentReturns(node, name) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ReturnStatement') {
    node.argument = traceCall(name, node.argument || identifier('undefined'));
    return;
  }
  if (node !== ast && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((item) => instrumentReturns(item, name));
    else if (value && typeof value.type === 'string') instrumentReturns(value, name);
  }
}

function instrumentFunction(node, name) {
  if (!node.body || node.body.type !== 'BlockStatement') return;
  node.body.body.unshift({
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: identifier(traceArgs),
      init: {
        type: 'ArrayExpression',
        elements: node.params.slice(0, 2).map((parameter) => parameter.type === 'Identifier' ? identifier(parameter.name) : identifier('undefined')),
      },
    }],
  });
  instrumentDecoderCalls(node.body, name);
  instrumentReturns(node.body, name);
  instrumentCallSiteReturns(node.body, name);
  instrumented.push({ name, start: node.start, end: node.end });
}

function instrumentCallSiteReturns(node, name) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ReturnStatement') {
    node.argument = traceCallSite(node, name, node.argument || identifier('undefined'));
    return;
  }
  if (node !== ast && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((item) => instrumentCallSiteReturns(item, name));
    else if (value && typeof value.type === 'string') instrumentCallSiteReturns(value, name);
  }
}

function instrumentDecoderCalls(node, name) {
  if (!node || typeof node !== 'object') return node;
  if (node.type !== 'CallExpression' && node !== ast && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return node;
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && decoderNames.has(node.callee.name)) {
    return traceCallSite(node, name, node);
  }
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) node[key] = value.map((item) => instrumentDecoderCalls(item, name));
    else if (value && typeof value.type === 'string') node[key] = instrumentDecoderCalls(value, name);
  }
  return node;
}

const decoderFunctions = [];
function collectDecoderFunctions(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration' && node.id && (decoderNames.has(node.id.name) || hasDirectDecoderCall(node.body, node.body))) {
    decoderFunctions.push(node);
  }
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(collectDecoderFunctions);
    else if (value && typeof value.type === 'string') collectDecoderFunctions(value);
  }
}
collectDecoderFunctions(ast);
decoderFunctions.forEach((node) => instrumentFunction(node, node.id.name));

const prelude = `(function (global) {
  global.__xyzwRuntimeTracerLoaded = true;
  if (typeof global.__xyzwRuntimeTrace !== 'function') {
    var queue = global.__xyzwRuntimeTraceBuffer || (global.__xyzwRuntimeTraceBuffer = []);
    global.__xyzwRuntimeTrace = function (name, index, key, value) {
      if (queue.length < 200000) queue.push([name, index, key, value]);
      return value;
    };
  }
  if (typeof global.__xyzwRuntimeTraceCall !== 'function') {
    var callQueue = global.__xyzwRuntimeTraceCallBuffer || (global.__xyzwRuntimeTraceCallBuffer = []);
    global.__xyzwRuntimeTraceCall = function (site, name, value) {
      if (callQueue.length < 200000) callQueue.push([site, name, value]);
      return value;
    };
  }
})(typeof globalThis === 'object' ? globalThis : window);
`;
const output = `${prelude}${escodegen.generate(ast, {
  format: {
    indent: { style: '  ' },
    compact: false,
    semicolons: true,
    quotes: 'single',
  },
})}\n`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, 'utf8');
console.log(JSON.stringify({
  sourcePath,
  outputPath,
  instrumented,
  outputBytes: Buffer.byteLength(output),
}));