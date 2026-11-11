import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Git Tool');
  return channel;
}

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly code: number | null, readonly stderr: string, readonly stdout: string) {
    super(message);
  }
}

export interface RunOptions {
  input?: string;
  /** Write the command and its output to the output channel. */
  log?: boolean;
  env?: Record<string, string>;
}

const BASE = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat'];

// Background reads across many repositories otherwise start dozens of Git
// processes at once and starve the extension host. Logged (user) commands bypass the limit.
const MAX_BACKGROUND = 6;
let running = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < MAX_BACKGROUND) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

export async function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  if (opts.log) return spawnGit(cwd, args, opts);
  await acquire();
  try { return await spawnGit(cwd, args, opts); } finally { release(); }
}

function spawnGit(cwd: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (opts.log) output().appendLine(`[${cwd}] > git ${args.join(' ')}`);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...opts.env };
    const child = spawn('git', [...BASE, ...args], { cwd, env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => { out.push(d); if (opts.log) output().append(d.toString('utf8')); });
    child.stderr.on('data', (d: Buffer) => { err.push(d); if (opts.log) output().append(d.toString('utf8')); });
    child.on('error', e => reject(new GitError(e.message, args, null, e.message, '')));
    child.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (opts.log) {
        const ch = output();
        ch.appendLine(`[${cwd}] git ${args[0]} finished: exit ${code}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
      if (code === 0) resolve(stdout);
      else reject(new GitError((stderr || stdout).trim() || `git exited with code ${code}`, args, code, stderr, stdout));
    });
    if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8');
    else child.stdin.end();
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function gitTry(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}
