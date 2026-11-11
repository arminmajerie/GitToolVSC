import * as vscode from 'vscode';
import type { Repos } from './repos';

export interface LogHost {
  show(repo: string, opts?: { branch?: string; range?: string; paths?: string[]; select?: string; title?: string }): Promise<void>;
  nav(hash: string, dir: number): void;
}

export const ctx = {} as {
  ext: vscode.ExtensionContext;
  repos: Repos;
  log: LogHost;
};
