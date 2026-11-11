const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../media/common.css'), 'utf8') + fs.readFileSync(path.join(__dirname, '../media/commit.css'), 'utf8') });
    await page.evaluate(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: m => window.sent.push(m) });
      window.vscgitAssets = { push: 'data:image/png;base64,', forcePush: 'data:image/png;base64,' };
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../media/common.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../media/commit.js'), 'utf8') });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'init' } }));
      const repo = (name, staged, unstaged, checked = true) => ({ repo: '/work/' + name, repoName: name, branch: 'main', checked, staged, unstaged, untracked: [], conflicts: [] });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'status', repo: '/work/parent', repositories: [
        repo('parent', [], [{ path: 'ib-server', status: 'M' }]),
        repo('ib-server', [{ path: 'crates/core.rs', status: 'M' }], []),
        repo('sibling', [{ path: 'package.json', status: 'M' }], [], false)
      ] } }));
    });
    assert.equal(await page.locator('.repository-tree').count(), 0);
    assert.equal(await page.locator('.repository-group').count(), 3);
    assert.equal(await page.getByRole('button', { name: 'Commit Checked', exact: true }).count(), 0);
    await page.locator('.repository-group').filter({ hasText: 'ib-server' }).first().click();
    await page.getByTitle('Unstage folder', { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'unstage', repo: '/work/ib-server', paths: ['crates/core.rs'] });
    await page.getByTitle('Push', { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'pushChecked' });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(__dirname, '../commit-ui-verified.png'), fullPage: true });
    console.log('PASS: aggregate repository groups, explicit folder owner, checked push, no duplicate controls, no JavaScript errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
