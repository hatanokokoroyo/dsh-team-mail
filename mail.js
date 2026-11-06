/**
 * Thin JSON wrapper around the bundled mail.py CLI.
 *
 * The Python CLI stays the single implementation of IMAP/SMTP behaviour
 * (MIME decoding, modified UTF-7 folder names, attachments). This module only
 * spawns it, hands it the current account through the environment, and parses
 * JSON. The engine keeps no configuration file of its own, so the panel and
 * the CLI always agree on account, servers, and signature.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SCRIPT = fileURLToPath(new URL('./mail.py', import.meta.url));

/** Canonical id: IMAP uids are per-folder, so the folder is part of the identity. */
export function messageId(folder, uid) {
  return `${folder}:${uid}`;
}

export function splitId(id) {
  const raw = String(id ?? '').trim();
  const at = raw.lastIndexOf(':');
  if (at <= 0) throw new Error(`无效邮件 id「${raw}」，应形如 INBOX:269（文件夹:uid）`);
  const folder = raw.slice(0, at);
  const uid = Number(raw.slice(at + 1));
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`无效邮件 id「${raw}」：uid 必须是正整数`);
  return { folder, uid };
}

export class MailCli {
  /**
   * @param options.python - Python interpreter (default `python3`).
   * @param options.script - path to mail.py.
   * @param options.timeoutMs - per-invocation timeout.
   * @param options.resolveEnv - async () => object merged over process.env,
   *   used to pass the account captured at call time.
   */
  constructor({
    python = process.env.DSH_TEAM_MAIL_PYTHON || 'python3',
    script = DEFAULT_SCRIPT,
    timeoutMs = 90_000,
    resolveEnv,
  } = {}) {
    this.python = python;
    this.script = script;
    this.timeoutMs = timeoutMs;
    this.resolveEnv = resolveEnv;
  }

  /** Run the CLI and resolve stdout text. Non-zero exit rejects with stderr content. */
  async run(args, { input } = {}) {
    const extra = this.resolveEnv ? await this.resolveEnv() : {};
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...extra },
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`mail.py 超时（${this.timeoutMs}ms）：${args.join(' ')}`));
      }, this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > 32 * 1024 * 1024) {
          child.kill('SIGKILL');
          finish(new Error('mail.py 输出过大'));
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => finish(new Error(`无法启动 ${this.python}：${error.message}`)));
      child.on('close', (code) => {
        if (code === 0) finish(undefined, stdout);
        else finish(new Error((stderr || stdout || `mail.py 退出码 ${code}`).trim()));
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    });
  }

  async json(args, options) {
    const text = await this.run(args, options);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`mail.py 输出不是合法 JSON（${args.join(' ')}）：${text.slice(0, 400)}`);
    }
  }

  folders() {
    return this.json(['folders', '--json']);
  }

  sync(folder, afterUid = 0, limit = 300) {
    return this.json(['sync', '--folder', folder, '--after-uid', String(afterUid), '--limit', String(limit)]);
  }

  list({ folder, unseen, from, subject, text, since, limit = 20, scan = 300 } = {}) {
    const args = ['list', '--json', '--limit', String(limit), '--scan', String(scan)];
    if (folder) args.push('--folder', folder);
    if (unseen) args.push('--unseen');
    if (from) args.push('--from', from);
    if (subject) args.push('--subject', subject);
    if (text) args.push('--text', text);
    if (since) args.push('--since', since);
    return this.json(args);
  }

  read(folder, uid, { html = false, maxChars = 8000, markSeen = false, saveAttachments = false, saveAttachmentsDir } = {}) {
    const args = ['read', '--uid', String(uid), '--folder', folder, '--json', '--max-chars', String(maxChars)];
    if (html) args.push('--html');
    if (markSeen) args.push('--mark-seen');
    if (saveAttachments && saveAttachmentsDir) args.push('--save-attachments', saveAttachmentsDir);
    return this.json(args);
  }

  async send({ to, cc, bcc, subject, body, html = false, attachments = [] }) {
    const args = ['send', '--to', ...to, '--subject', subject, '--body', '-'];
    if (cc?.length) args.push('--cc', ...cc);
    if (bcc?.length) args.push('--bcc', ...bcc);
    if (html) args.push('--html');
    if (attachments.length) args.push('--attach', ...attachments);
    return this.json(args, { input: body ?? '' });
  }

  async reply(folder, uid, { body, all = false, quote = false, attachments = [] }) {
    const args = ['reply', '--uid', String(uid), '--folder', folder, '--body', '-'];
    if (all) args.push('--all');
    if (quote) args.push('--quote');
    if (attachments.length) args.push('--attach', ...attachments);
    return this.json(args, { input: body ?? '' });
  }

  mark(folder, uids, seen) {
    const args = ['mark', '--folder', folder, '--uid', ...uids.map(String)];
    args.push(seen ? '--seen' : '--unseen');
    return this.json(args);
  }

  move(folder, uids, to) {
    return this.json(['move', '--folder', folder, '--to', to, '--uid', ...uids.map(String)]);
  }
}
