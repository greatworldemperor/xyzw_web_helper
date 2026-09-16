#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('../node_modules/.pnpm/acorn@8.16.0/node_modules/acorn');
const escodegen = require('../node_modules/.pnpm/escodegen@2.1.0/node_modules/escodegen/escodegen.js');

const UNKNOWN = Symbol('unknown');
const MAX_STATIC_DEPTH = 48;
const MAX_FUNCTION_DEPTH = 24;
const sourcePath = path.resolve(process.argv[2] || 'scripts/7.7.12.js');
const outputPath = path.resolve(process.argv[3] || 'scripts/7.7.12.deobfuscated.js');
const mapPath = `${outputPath}.map.json`;
const source = fs.readFileSync(sourcePath, 'utf8');
const runtimeTracePath = process.argv[4] ? path.resolve(process.argv[4]) : null;
let runtimeTrace = null;

function buildDecoderContext(code) {
  const decoder = code.slice(0, 1695);
  // These slices end inside the original comma expression; close each IIFE
  // when evaluating it independently, matching the validated bootstrap probe.
  const rotateOne = code.slice(1695, 2710) + ')';
  const rotateTwo = code.slice(2711, 9093) + ')';
  const a0w = code.slice(4015865, 4026897);
  const a0b = code.slice(4026897, 5579265);
  const a0o = code.slice(5579265);
  const context = {};
  vm.createContext(context);
  for (const fragment of [decoder, a0w, a0b, a0o, rotateOne, rotateTwo]) {
    vm.runInContext(fragment, context, { timeout: 120000 });
  }
  return context;
}

function isPrimitive(value) {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value);
}

function traceArgumentKey(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN'];
    if (Object.is(value, -0)) return ['number', '-0'];
  }
  return [typeof value, value];
}

function traceKey(name, first, second) {
  return JSON.stringify([name, traceArgumentKey(first), traceArgumentKey(second)]);
}

function loadRuntimeTrace(filePath) {
  if (!filePath) return null;
  const trace = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const values = new Map();
  const callSites = new Map();
  for (const entry of trace.values || []) {
    if (!entry || entry.alternateValues || typeof entry.value !== 'string') continue;
    if (!['number', 'string', 'boolean'].includes(typeof entry.index)) continue;
    if (typeof entry.key !== 'string' && typeof entry.key !== 'number') continue;
    const key = traceKey(entry.name, entry.index, entry.key);
    if (!values.has(key)) values.set(key, entry.value);
  }
  for (const entry of trace.callSites || []) {
    if (!entry || entry.alternateValues || !Number.isInteger(entry.site)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof entry.value)) continue;
    if (!callSites.has(entry.site)) callSites.set(entry.site, entry.value);
  }
  return { values, callSites, calls: trace.calls || 0, unique: trace.unique || 0, source: filePath };
}

function lookupRuntimeTrace(name, args) {
  if (!runtimeTrace || args.length < 2 || !args.slice(0, 2).every(isPrimitive)) return UNKNOWN;
  const key = traceKey(name, args[0], args[1]);
  return runtimeTrace.values.has(key) ? runtimeTrace.values.get(key) : UNKNOWN;
}

function lookupRuntimeCallSite(node) {
  if (!runtimeTrace || !node || !runtimeTrace.callSites) return UNKNOWN;
  return runtimeTrace.callSites.has(node.start) ? runtimeTrace.callSites.get(node.start) : UNKNOWN;
}

function lookupRuntimeTraceForNode(node, environment, decoderContext, functions) {
  if (!runtimeTrace || !node || node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return UNKNOWN;
  const args = node.arguments.map((argument) => evaluateStatic(argument, environment, decoderContext, functions));
  if (args.some((value) => value === UNKNOWN)) return UNKNOWN;
  return lookupRuntimeTrace(node.callee.name, args);
}

function makeStaticObject(properties) {
  return { __deobfuscatorStaticObject: true, properties };
}

function makeStaticArray(values) {
  return { __deobfuscatorStaticArray: true, values };
}

function makeStaticFunction(node, environment) {
  return { __deobfuscatorStaticFunction: true, node, environment };
}

function isStaticObject(value) {
  return value && value.__deobfuscatorStaticObject === true;
}

function isStaticArray(value) {
  return value && value.__deobfuscatorStaticArray === true;
}

function isStaticFunction(value) {
  return value && value.__deobfuscatorStaticFunction === true;
}

function staticProperty(value, property) {
  if (isStaticObject(value)) {
    return value.properties.has(String(property)) ? value.properties.get(String(property)) : UNKNOWN;
  }
  if (isStaticArray(value) && property === 'length') {
    return value.values.length;
  }
  if (Array.isArray(value) && property in value) {
    return value[property];
  }
  if (value && typeof value === 'object' && property in value) {
    return value[property];
  }
  return UNKNOWN;
}

function makeEnvironment(parent = null) {
  return {
    values: new Map(parent ? parent.values : []),
    functions: new Map(parent ? parent.functions : []),
  };
}

function addFunction(environment, name, node) {
  if (!name) return;
  const list = environment.functions.get(name) || [];
  list.push(node);
  environment.functions.set(name, list);
}

function findFunction(environment, name, position, functions) {
  const localCandidates = environment.functions.get(name) || [];
  const candidates = localCandidates.length
    ? localCandidates
    : ((functions && functions.get(name)) || []);
  const containing = candidates
    .filter((node) => node.start <= position && position <= node.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start));
  return containing[0] || candidates[0] || null;
}

function evaluateBinary(operator, left, right) {
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  try {
    switch (operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '%': return left % right;
      case '**': return left ** right;
      case '<<': return left << right;
      case '>>': return left >> right;
      case '>>>': return left >>> right;
      case '&': return left & right;
      case '|': return left | right;
      case '^': return left ^ right;
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '==': return left == right;
      case '!=': return left != right;
      case '===': return left === right;
      case '!==': return left !== right;
      default: return UNKNOWN;
    }
  } catch {
    return UNKNOWN;
  }
}

function evaluateStatic(node, environment, decoderContext, functions, depth = 0) {
  if (!node || depth > MAX_STATIC_DEPTH) return UNKNOWN;

  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Identifier':
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      if (environment.values.has(node.name)) return environment.values.get(node.name);
      {
        const functionNode = findFunction(environment, node.name, node.start, functions);
        return functionNode ? makeStaticFunction(functionNode, environment) : UNKNOWN;
      }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return makeStaticFunction(node, environment);
    case 'ArrayExpression': {
      const values = node.elements.map((item) => evaluateStatic(item, environment, decoderContext, functions, depth + 1));
      return values.some((value) => value === UNKNOWN) ? UNKNOWN : makeStaticArray(values);
    }
    case 'ObjectExpression': {
      const properties = new Map();
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') continue;
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
        const value = evaluateStatic(property.value, environment, decoderContext, functions, depth + 1);
        properties.set(String(key), value);
      }
      return makeStaticObject(properties);
    }
    case 'MemberExpression': {
      const object = evaluateStatic(node.object, environment, decoderContext, functions, depth + 1);
      const property = node.computed
        ? evaluateStatic(node.property, environment, decoderContext, functions, depth + 1)
        : node.property.name;
      if (property === UNKNOWN || property === undefined) return UNKNOWN;
      return staticProperty(object, property);
    }
    case 'UnaryExpression': {
      const argument = evaluateStatic(node.argument, environment, decoderContext, functions, depth + 1);
      if (argument === UNKNOWN) return UNKNOWN;
      try {
        switch (node.operator) {
          case '+': return +argument;
          case '-': return -argument;
          case '~': return ~argument;
          case '!': return !argument;
          case 'typeof': return typeof argument;
          default: return UNKNOWN;
        }
      } catch {
        return UNKNOWN;
      }
    }
    case 'BinaryExpression':
      return evaluateBinary(
        node.operator,
        evaluateStatic(node.left, environment, decoderContext, functions, depth + 1),
        evaluateStatic(node.right, environment, decoderContext, functions, depth + 1),
      );
    case 'LogicalExpression': {
      const left = evaluateStatic(node.left, environment, decoderContext, functions, depth + 1);
      if (left === UNKNOWN) return UNKNOWN;
      if (node.operator === '&&') return left ? evaluateStatic(node.right, environment, decoderContext, functions, depth + 1) : left;
      if (node.operator === '||') return left ? left : evaluateStatic(node.right, environment, decoderContext, functions, depth + 1);
      if (node.operator === '??') return left == null ? evaluateStatic(node.right, environment, decoderContext, functions, depth + 1) : left;
      return UNKNOWN;
    }
    case 'ConditionalExpression': {
      const test = evaluateStatic(node.test, environment, decoderContext, functions, depth + 1);
      if (test === UNKNOWN) return UNKNOWN;
      return evaluateStatic(test ? node.consequent : node.alternate, environment, decoderContext, functions, depth + 1);
    }
    case 'SequenceExpression': {
      let value = UNKNOWN;
      for (const expression of node.expressions) value = evaluateStatic(expression, environment, decoderContext, functions, depth + 1);
      return value;
    }
    case 'TemplateLiteral': {
      let result = '';
      for (let index = 0; index < node.quasis.length; index += 1) {
        result += node.quasis[index].value.cooked;
        if (index < node.expressions.length) {
          const value = evaluateStatic(node.expressions[index], environment, decoderContext, functions, depth + 1);
          if (value === UNKNOWN) return UNKNOWN;
          result += value;
        }
      }
      return result;
    }
    case 'AssignmentExpression': {
      if (node.operator !== '=') return UNKNOWN;
      const value = evaluateStatic(node.right, environment, decoderContext, functions, depth + 1);
      if (value === UNKNOWN) return UNKNOWN;
      if (node.left.type === 'Identifier') {
        environment.values.set(node.left.name, value);
        return value;
      }
      if (node.left.type === 'MemberExpression') {
        const object = evaluateStatic(node.left.object, environment, decoderContext, functions, depth + 1);
        const property = node.left.computed
          ? evaluateStatic(node.left.property, environment, decoderContext, functions, depth + 1)
          : node.left.property.name;
        if (property === UNKNOWN || property === undefined || !isStaticObject(object)) return UNKNOWN;
        object.properties.set(String(property), value);
        return value;
      }
      return UNKNOWN;
    }
    case 'CallExpression': {
      const args = node.arguments.map((argument) => evaluateStatic(argument, environment, decoderContext, functions, depth + 1));
      if (args.some((value) => value === UNKNOWN)) return UNKNOWN;
      if (node.callee.type === 'Identifier') {
        const name = node.callee.name;
        const runtimeValue = lookupRuntimeTrace(name, args);
        if (runtimeValue !== UNKNOWN) return runtimeValue;
        if ((name === 'a0D' || name === 'a0w') && args.length === 2) {
          try {
            const value = decoderContext[name](args[0], args[1]);
            return typeof value === 'string' || isPrimitive(value) ? value : UNKNOWN;
          } catch {
            return UNKNOWN;
          }
        }
        const value = environment.values.get(name);
        if (isStaticFunction(value)) return evaluateFunction(value.node, args, value.environment, decoderContext, functions, depth + 1);
        const functionNode = findFunction(environment, name, node.start, functions);
        if (!functionNode) return UNKNOWN;
        return evaluateFunction(functionNode, args, environment, decoderContext, functions, depth + 1);
      }
      const value = evaluateStatic(node.callee, environment, decoderContext, functions, depth + 1);
      return isStaticFunction(value)
        ? evaluateFunction(value.node, args, value.environment, decoderContext, functions, depth + 1)
        : UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

function evaluateStatement(statement, environment, decoderContext, functions, depth) {
  if (!statement || depth > 20) return { returned: false, value: UNKNOWN };
  if (statement.type === 'FunctionDeclaration') {
    addFunction(environment, statement.id.name, statement);
    return { returned: false, value: UNKNOWN };
  }
  if (statement.type === 'VariableDeclaration') {
    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier') {
        environment.values.set(declaration.id.name, evaluateStatic(declaration.init, environment, decoderContext, functions, depth + 1));
      }
    }
    return { returned: false, value: UNKNOWN };
  }
  if (statement.type === 'ReturnStatement') {
    return { returned: true, value: evaluateStatic(statement.argument, environment, decoderContext, functions, depth + 1) };
  }
  if (statement.type === 'BlockStatement') {
    for (const child of statement.body) {
      const result = evaluateStatement(child, environment, decoderContext, functions, depth + 1);
      if (result.returned) return result;
    }
    return { returned: false, value: UNKNOWN };
  }
  if (statement.type === 'IfStatement') {
    const test = evaluateStatic(statement.test, environment, decoderContext, functions, depth + 1);
    if (test === UNKNOWN) return { returned: false, value: UNKNOWN };
    return evaluateStatement(test ? statement.consequent : statement.alternate, environment, decoderContext, functions, depth + 1);
  }
  return { returned: false, value: UNKNOWN };
}

function evaluateFunction(functionNode, args, parentEnvironment, decoderContext, functions, depth) {
  if (depth > MAX_FUNCTION_DEPTH) return UNKNOWN;
  const decoderName = functionNode.id && functionNode.id.name;
  if ((decoderName === 'a0D' || decoderName === 'a0w') && args.length === 2) {
    try {
      const value = decoderContext[decoderName](args[0], args[1]);
      return typeof value === 'string' || isPrimitive(value) ? value : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }
  const environment = makeEnvironment(parentEnvironment);
  functionNode.params.forEach((parameter, index) => {
    if (parameter.type === 'Identifier') environment.values.set(parameter.name, args[index] === undefined ? undefined : args[index]);
  });
  if (functionNode.body.type !== 'BlockStatement') {
    return evaluateStatic(functionNode.body, environment, decoderContext, functions, depth + 1);
  }
  for (const statement of functionNode.body.body || []) {
    const result = evaluateStatement(statement, environment, decoderContext, functions, depth + 1);
    if (result.returned) return result.value;
  }
  return UNKNOWN;
}

function literalNode(value) {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'Identifier', name: 'NaN' };
    if (value === Infinity) return { type: 'Identifier', name: 'Infinity' };
    if (value === -Infinity) {
      return {
        type: 'UnaryExpression',
        operator: '-',
        prefix: true,
        argument: { type: 'Identifier', name: 'Infinity' },
      };
    }
    if (value < 0 || Object.is(value, -0)) {
      return {
        type: 'UnaryExpression',
        operator: '-',
        prefix: true,
        argument: { type: 'Literal', value: Math.abs(value), raw: String(Math.abs(value)) },
      };
    }
  }
  return { type: 'Literal', value, raw: JSON.stringify(value) };
}

function staticPrimitive(value) {
  return value === null || ['boolean', 'number', 'string'].includes(typeof value);
}

function transformAssignmentTarget(node, environment, decoderContext, functions, report) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'MemberExpression') {
    node.object = transformNode(node.object, environment, decoderContext, functions, report);
    if (node.computed) node.property = transformNode(node.property, environment, decoderContext, functions, report);
    return node;
  }
  if (node.type === 'Identifier' || node.type === 'ThisExpression') return node;
  return transformNode(node, environment, decoderContext, functions, report);
}

function transformNode(node, environment, decoderContext, functions, report) {
  if (!node || typeof node !== 'object' || !node.type) return node;

  if (node.type === 'ReturnStatement') {
    const observed = lookupRuntimeCallSite(node);
    if (observed !== UNKNOWN) {
      report.replacements.push({ start: node.start, end: node.end, kind: 'runtime-call-site', value: observed });
      node.argument = literalNode(observed);
      return node;
    }
  }

  if (node.type === 'Program' || node.type === 'BlockStatement') {
    const childEnvironment = makeEnvironment(environment);
    for (const statement of node.body) {
      if (statement.type === 'FunctionDeclaration') addFunction(childEnvironment, statement.id.name, statement);
    }
    node.body = node.body.map((statement) => transformNode(statement, childEnvironment, decoderContext, functions, report));
    return node;
  }

  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    const childEnvironment = makeEnvironment(environment);
    for (const parameter of node.params || []) {
      if (parameter.type === 'Identifier') childEnvironment.values.set(parameter.name, UNKNOWN);
    }
    for (const statement of node.body && node.body.body ? node.body.body : []) {
      if (statement.type === 'FunctionDeclaration') addFunction(childEnvironment, statement.id.name, statement);
    }
    if (node.body && node.body.type === 'BlockStatement') node.body = transformNode(node.body, childEnvironment, decoderContext, functions, report);
    else if (node.body) node.body = transformNode(node.body, childEnvironment, decoderContext, functions, report);
    return node;
  }

  if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      if (declaration.init) {
        declaration.init = transformNode(declaration.init, environment, decoderContext, functions, report);
        const value = evaluateStatic(declaration.init, environment, decoderContext, functions);
        if (declaration.id.type === 'Identifier') environment.values.set(declaration.id.name, value);
      }
    }
    return node;
  }

  if (node.type === 'AssignmentExpression') {
    node.left = transformAssignmentTarget(node.left, environment, decoderContext, functions, report);
    node.right = transformNode(node.right, environment, decoderContext, functions, report);
    const evaluated = evaluateStatic(node, environment, decoderContext, functions);
    return evaluated === UNKNOWN ? node : node;
  }

  if (node.type === 'UpdateExpression') {
    node.argument = transformAssignmentTarget(node.argument, environment, decoderContext, functions, report);
    return node;
  }

  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc', 'raw'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) node[key] = value.map((item) => transformNode(item, environment, decoderContext, functions, report));
    else if (value && typeof value.type === 'string') node[key] = transformNode(value, environment, decoderContext, functions, report);
  }

  const evaluated = evaluateStatic(node, environment, decoderContext, functions);
  if (staticPrimitive(evaluated) && node.type !== 'Literal' && node.type !== 'Identifier' && node.type !== 'AssignmentExpression') {
    const runtimeObserved = lookupRuntimeTraceForNode(node, environment, decoderContext, functions) !== UNKNOWN;
    const isDecoder = node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['a0D', 'a0w'].includes(node.callee.name);
    report.replacements.push({ start: node.start, end: node.end, kind: runtimeObserved ? 'runtime' : isDecoder ? node.callee.name : 'constant', value: evaluated });
    return literalNode(evaluated);
  }
  return node;
}

function collectFunctionDeclarations(node, functions) {
  if (!node || typeof node !== 'object' || !node.type) return;
  if (node.type === 'FunctionDeclaration' && node.id) {
    const list = functions.get(node.id.name) || [];
    list.push(node);
    functions.set(node.id.name, list);
  }
  for (const key of Object.keys(node)) {
    if (['start', 'end', 'loc'].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((item) => collectFunctionDeclarations(item, functions));
    else if (value && typeof value.type === 'string') collectFunctionDeclarations(value, functions);
  }
}

function main() {
  const decoderContext = buildDecoderContext(source);
  runtimeTrace = loadRuntimeTrace(runtimeTracePath);
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const functions = new Map();
  collectFunctionDeclarations(ast, functions);
  const report = {
    source: sourcePath,
    output: outputPath,
    runtimeTrace: runtimeTrace ? { source: runtimeTrace.source, calls: runtimeTrace.calls, unique: runtimeTrace.unique, usableEntries: runtimeTrace.values.size, usableCallSites: runtimeTrace.callSites.size } : null,
    replacements: [],
    decoderTableLengths: { a0b: decoderContext.a0b().length, a0o: decoderContext.a0o().length },
  };
  transformNode(ast, makeEnvironment(), decoderContext, functions, report);
  const outputMode = runtimeTrace ? 'runtime-assisted observation pass; only stable observed calls were replaced' : 'behavior-preserving pass: decoded literals and static constants only';
  const output = `/* Generated by tools/deobfuscate-7.7.12.cjs. Original: ${path.basename(sourcePath)}. ${outputMode}. */\n${escodegen.generate(ast, { format: { indent: { style: '  ' }, compact: false, semicolons: true, quotes: 'single' } })}\n`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  fs.writeFileSync(mapPath, `${JSON.stringify({ ...report, replacementCount: report.replacements.length }, null, 2)}\n`, 'utf8');
  const runtimeReplacementCount = report.replacements.filter((replacement) => replacement.kind === 'runtime' || replacement.kind === 'runtime-call-site').length;
  console.log(JSON.stringify({ outputPath, mapPath, replacementCount: report.replacements.length, runtimeReplacementCount, decoderTableLengths: report.decoderTableLengths, outputBytes: Buffer.byteLength(output) }));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
