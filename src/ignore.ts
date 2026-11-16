import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ctx } from './ctx';
import { git } from './git';

export async function addIgnoreEntries(repo: string, paths: string[], local = false): Promise<void> {
  const entries = [];
  for (const relative of paths) {
    if (!relative || relative === '.' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || /[\r\n\0]/.test(relative)) {
      throw new Error('Select files or folders inside the repository, not the repository root.');
    }
    let directory = false;
    try { directory = (await fs.stat(path.join(repo, relative))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const literal = relative.replace(/[\\*?\[\] ]/g, '\\$&');
    entries.push('/' + literal + (directory ? '/' : ''));
  }
  if (!entries.length) return;
  const file = local
    ? path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim())
    : path.join(repo, '.gitignore');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const existing = new Set(text.split(/\r?\n/));
  const added = [...new Set(entries)].filter(entry => !existing.has(entry));
  if (!added.length) return;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, (text && !text.endsWith('\n') ? newline : '') + added.join(newline) + newline, 'utf8');
  ctx.repos.changed(repo);
}