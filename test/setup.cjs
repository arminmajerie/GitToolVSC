const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'gittool-test-hooks-'));
const configCount = Number(process.env.GIT_CONFIG_COUNT || 0);
process.env[`GIT_CONFIG_KEY_${configCount}`] = 'core.hooksPath';
process.env[`GIT_CONFIG_VALUE_${configCount}`] = hooks;
process.env.GIT_CONFIG_COUNT = String(configCount + 1);
process.on('exit', () => fs.rmSync(hooks, { recursive: true, force: true }));
