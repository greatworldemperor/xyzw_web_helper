'use strict';
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[2] || 'scripts/7.7.12.js', 'utf8');
const result = {};
const fragments = {
  declarations: [source.slice(0, 1695), source.slice(4015865, 4026897), source.slice(4026897, 5579265), source.slice(5579265)].join('\n'),
  rotateOne: source.slice(1695, 2710) + ')',
  rotateTwo: source.slice(2711, 9093) + ')',
};
const context = {};
vm.createContext(context);
for (const [name, code] of Object.entries(fragments)) {
  try {
    vm.runInContext(code, context, { timeout: 120000 });
    result[name] = 'ok';
    if (name === 'declarations') {
      result.declarationTypes = {
        a0b: typeof context.a0b,
        a0o: typeof context.a0o,
        a0w: typeof context.a0w,
      };
    }
    if (name === 'rotateOne') {
      result[`${name}Tables`] = {
        a0b: typeof context.a0b === 'function' ? context.a0b().length : null,
        a0o: typeof context.a0o === 'function' ? context.a0o().length : null,
      };
    }
  } catch (error) {
    result[name] = {
      name: error.name,
      message: error.message,
    };
    break;
  }
}
if (result.rotateTwo === 'ok') {
  result.samples = {
    skip150Enabled: context.a0w(8618, 'czxl'),
    skip150Label: context.a0w(1041, 'D70C'),
  };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
