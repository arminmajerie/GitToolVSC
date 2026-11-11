const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('repository labels show the final folder for Windows and slash paths', () => {
  const context = { acquireVsCodeApi: () => ({}) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/common.js'), 'utf8'), context);
  assert.equal(vm.runInContext('baseName("E:\\\\workspace\\\\security-patches\\\\wry")', context), 'wry');
  assert.equal(vm.runInContext('baseName("/workspace/security-patches/wry")', context), 'wry');
});
