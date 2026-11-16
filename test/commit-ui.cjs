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
        { ...repo('parent', [], [{ path: 'ib-server', status: 'M' }]), untracked: [{ path: 'Application/source/new-file.ts', status: '?' }] },
        repo('ib-server', [{ path: 'crates/core.rs', status: 'M' }], []),
        repo('sibling', [{ path: 'package.json', status: 'M' }], [], false)
      ] } }));
    });
    assert.equal(await page.locator('.repository-tree').count(), 0);
    await page.locator('textarea.msg').fill('Publish staged changes');
    await page.getByRole('button', { name: 'Commit&Push', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'commitChecked', message: 'Publish staged changes', amend: false, push: true });
    await page.locator('textarea.msg').evaluate(editor => { editor.style.height = '1000px'; });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'batchProgress', message: 'Batch ended. Refreshing repositories…' } })));
    for (const [width, height] of [[320, 420], [700, 420], [700, 900]]) {
      await page.setViewportSize({ width, height });
      for (const name of ['Commit', 'Commit&Push', 'Push', 'Force push']) {
        const bounds = await page.locator('.commit-box').getByRole('button', { name, exact: true }).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= height, `${name} must remain inside a ${width}x${height}px panel during progress`);
      }
    }
    assert.equal(await page.locator('.repository-group').count(), 4);
    assert.equal(await page.getByRole('button', { name: 'Commit Checked', exact: true }).count(), 0);
    for (const group of ['staged', 'untracked']) {
      const positions = await page.locator(`.group-${group}`).evaluate(header => ({
        section: header.querySelector('.twisty').getBoundingClientRect().left,
        repo: header.nextElementSibling.querySelector('.twisty').getBoundingClientRect().left
      }));
      assert.equal(positions.repo - positions.section, 14, `${group} repository must be a child of its section`);
    }
    await page.locator('.group-untracked + .repository-group').click();
    const nesting = await page.locator('.group-untracked + .repository-group').evaluate(repo => ({
      repo: repo.querySelector('.twisty').getBoundingClientRect().left,
      folder: repo.nextElementSibling.querySelector('.twisty').getBoundingClientRect().left
    }));
    assert.equal(nesting.folder - nesting.repo, 14, 'folders must be children of the repository');
    await page.locator('.repository-group').filter({ hasText: 'ib-server' }).first().click();
    for (const width of [700, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: path.join(__dirname, `../commit-tree-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 700, height: 900 });
    await page.getByTitle('Unstage folder', { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'unstage', repo: '/work/ib-server', paths: ['crates/core.rs'] });
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'pushChecked' });
    await page.evaluate(() => {
      const repo = (name, sync) => ({ repo: '/work/' + name, repoName: name, branch: 'main', checked: true, staged: [], unstaged: [], untracked: [], conflicts: [], sync });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'status', repo: '/work/parent', repositories: [
        repo('parent', { ahead: 1, behind: 0, upstream: true }), repo('squashed', { ahead: 3, behind: 5, upstream: true })
      ] } }));
    });
    assert.equal(await page.getByRole('button', { name: 'Force push', exact: true }).count(), 1, 'force push stays available when nothing is left to commit');
    assert.ok(await page.getByRole('button', { name: 'Force push', exact: true }).evaluate(b => b.classList.contains('needed')), 'diverged history highlights force push');
    assert.match(await page.locator('.push-actions').textContent(), /↑4 ↓5 diverged/);
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'pushChecked' });
    await page.getByRole('button', { name: 'Force push', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'pushChecked', force: true });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(__dirname, '../commit-ui-verified.png'), fullPage: true });
    console.log('PASS: aggregate repository groups, explicit folder owner, checked push, no duplicate controls, no JavaScript errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
