/**
 * Host half of the team mail panel.
 *
 * Owns: the incremental mailbox poll, the envelope and ack cache, the HTTP
 * surface consumed by the panel, the session handoff ("交给 Agent"), the
 * `team_mail_*` tools, the configurable system-prompt section, and saving
 * panel configuration through DSH's config editor (the profile patch layer)
 * with the mailbox password kept in the local credential store.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, PASSWORD_REF, cliEnv, isConfigured, mergeConfig, publicConfig, readConfig } from './config.js';
import { buildPrompt, systemPromptText } from './prompt.js';
import { MailCli, splitId } from './mail.js';
import { MailStore, defaultStateFile } from './store.js';
import { createTeamMailTools } from './tools.js';

export { Config };

export const inject = ['webServer', 'tools', 'systemPrompt', 'sessionController', 'workspaceRegistry', 'connection'];

const MAX_SNAPSHOT_MESSAGES = 600;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function groupByFolder(ids) {
  const groups = new Map();
  for (const id of ids) {
    const { folder, uid } = splitId(id);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(uid);
  }
  return groups;
}

function addressOf(raw) {
  const text = String(raw || '').trim();
  const bracketed = /<([^>]+)>/.exec(text);
  return (bracketed ? bracketed[1] : text).trim().toLowerCase();
}

function isTrusted(from, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const address = addressOf(from);
  if (!address.includes('@')) return false;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return allowed.some((rule) => {
    const value = String(rule || '').trim().toLowerCase().replace(/^@/, '');
    if (!value) return false;
    return value.includes('@') ? address === value : domain === value || address.endsWith(`@${value}`);
  });
}

function inboxFolder(cfg) {
  return cfg.folders.find((folder) => /inbox/i.test(folder)) || cfg.folders[0] || 'INBOX';
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const store = new MailStore(defaultStateFile()).load();
  const attachmentsDir = join(homedir(), '.local', 'share', 'dsh-team-mail', 'attachments');
  const current = () => readConfig(config);

  async function credentialsService() {
    try {
      return ctx.get('credentials');
    } catch {
      return undefined;
    }
  }

  async function readPassword() {
    const credentials = await credentialsService();
    if (credentials) {
      try {
        const hit = await credentials.resolve(PASSWORD_REF);
        if (hit?.value) return hit.value;
      } catch {
        /* fall through to the environment */
      }
    }
    return process.env[PASSWORD_REF] || '';
  }

  async function credentialStatus() {
    const credentials = await credentialsService();
    if (!credentials) {
      const fromEnv = Boolean(process.env[PASSWORD_REF]);
      return { available: false, configured: fromEnv, writable: false, source: fromEnv ? 'environment' : null };
    }
    try {
      const info = await credentials.describe(PASSWORD_REF);
      return {
        available: true,
        configured: Boolean(info?.configured),
        writable: Boolean(info?.writable),
        source: info?.source || null,
      };
    } catch (error) {
      return {
        available: true,
        configured: false,
        writable: false,
        source: null,
        error: error?.message || String(error),
      };
    }
  }

  const cli = new MailCli({
    resolveEnv: async () => cliEnv(current(), await readPassword()),
  });

  let syncing = false;
  let prefetching = false;
  let lastAttempt = 0;
  let lastError = '';

  /**
   * Warm the body cache in the background, newest first, so a click in the
   * panel is served locally instead of opening a 1-2s IMAP read.
   */
  async function prefetchBodies() {
    if (prefetching) return;
    prefetching = true;
    try {
      const cfg = current();
      const limit = cfg.prefetchLimit;
      const first = inboxFolder(cfg);
      const all = store.allMessages();
      const candidates = [
        ...all.filter((m) => m.folder === first),
        ...all.filter((m) => m.folder !== first),
      ]
        .filter((m) => !store.getBody(m.id))
        .slice(0, limit);
      for (const message of candidates) {
        try {
          const detail = await cli.read(message.folder, message.uid, { maxChars: 12000 });
          store.setBody(message.id, detail).save();
        } catch (error) {
          logger.warn?.(`[dsh-team-mail] 预缓存 ${message.id} 失败: ${error?.message || error}`);
        }
      }
    } finally {
      prefetching = false;
    }
  }

  async function sync(force) {
    if (syncing) return;
    if (!isConfigured(current())) return;
    if (!force && Date.now() - lastAttempt < 5000) return;
    syncing = true;
    lastAttempt = Date.now();
    try {
      const cfg = current();
      for (const folder of cfg.folders) {
        const state = store.folder(folder);
        const result = await cli.sync(folder, state.lastUid || 0, 300);
        store.merge(folder, result.messages || [], {
          trusted: (from) => isTrusted(from, cfg.allowedSenders),
        });
      }
      store.setLastSync(Date.now()).save();
      lastError = '';
      void prefetchBodies();
    } catch (error) {
      lastError = error?.message || String(error);
      logger.warn?.(`[dsh-team-mail] 同步失败: ${lastError}`);
    } finally {
      syncing = false;
    }
  }

  async function buildSnapshot() {
    const cfg = current();
    const inbox = inboxFolder(cfg);
    const messages = store.allMessages().slice(0, MAX_SNAPSHOT_MESSAGES).map((message) => {
      const binding = store.bindingFor(message.id);
      const incoming = message.folder === inbox;
      return {
        id: message.id,
        folder: message.folder,
        uid: message.uid,
        direction: incoming ? 'in' : 'out',
        from: message.from,
        to: message.to,
        subject: message.subject,
        date: message.date,
        ts: message.ts,
        size: message.size,
        seen: message.seen,
        trusted: message.trusted,
        processed: incoming ? store.isAcked(message.folder, message.uid) : true,
        boundSessionId: binding?.sessionId || null,
      };
    });
    return {
      account: { user: cfg.email, displayName: cfg.displayName },
      config: publicConfig(cfg),
      configured: isConfigured(cfg),
      credential: await credentialStatus(),
      folders: cfg.folders,
      messages,
      counts: {
        inbox: messages.filter((m) => m.direction === 'in').length,
        sent: messages.filter((m) => m.direction === 'out').length,
        unprocessed: messages.filter((m) => m.direction === 'in' && !m.processed).length,
      },
      lastSync: store.lastSync,
      syncing,
      error: lastError,
    };
  }

  async function saveConfig(body) {
    const editor = ctx.get('configEditor');
    const entry = ctx.fiber?.entry;
    if (!editor || !entry) {
      throw new Error('当前 profile 不支持从面板保存配置，请手动编辑 profile 的 cordis.patch.yml');
    }
    const next = mergeConfig(current(), body || {});
    const flat = {
      email: next.email,
      displayName: next.displayName,
      signature: next.signature,
      imapHost: next.imap.host,
      imapPort: next.imap.port,
      imapSecure: next.imap.secure,
      smtpHost: next.smtp.host,
      smtpPort: next.smtp.port,
      smtpSecure: next.smtp.secure,
      folders: next.folders,
      pollSeconds: next.pollSeconds,
      prefetchLimit: next.prefetchLimit,
      allowedSenders: next.allowedSenders,
      contacts: next.contacts,
      instructions: next.instructions,
    };
    await editor.edit(entry, () => flat);
    return flat;
  }

  async function savePassword(value) {
    const credentials = await credentialsService();
    if (!credentials) throw new Error('当前 profile 没有可用的凭据服务，无法保存邮箱密码');
    const text = String(value || '');
    if (!text) throw new Error('密码不能为空');
    await credentials.set(PASSWORD_REF, text);
    return credentialStatus();
  }

  async function clearPassword() {
    const credentials = await credentialsService();
    if (!credentials) throw new Error('当前 profile 没有可用的凭据服务');
    await credentials.unset(PASSWORD_REF);
    return credentialStatus();
  }

  async function plant(body) {
    const id = String(body.id || '');
    const sessionId = String(body.sessionId || '');
    if (!sessionId) throw new Error('缺少 sessionId');
    const { folder, uid } = splitId(id);
    const message = await cli.read(folder, uid, { maxChars: 12000 });
    const text = buildPrompt({ message, id, template: body.template, instruction: body.instruction });
    await ctx.sessionController.prompt(
      {
        requestId: `team-mail-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        ...(body.clientTimeZone ? { clientTimeZone: body.clientTimeZone } : {}),
      },
      new AbortController().signal,
    );
    store.bind(sessionId, { id, subject: message.subject || '', from: message.from || '' }).save();
    return { sessionId, id };
  }

  async function handle(req, res) {
    if (!ctx.connection.authorizeIndex(req, res)) return;
    try {
      const url = new URL(req.url || '/', 'http://team-mail.invalid');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/team-mail/snapshot') {
        return json(res, 200, await buildSnapshot());
      }
      if (req.method === 'POST' && path === '/api/team-mail/refresh') {
        await sync(true);
        return json(res, 200, await buildSnapshot());
      }
      if (req.method === 'GET' && path === '/api/team-mail/message') {
        const id = String(url.searchParams.get('id') || '');
        const { folder, uid } = splitId(id);
        const save = url.searchParams.get('save') === '1';
        if (!save) {
          const cached = store.getBody(id);
          if (cached) return json(res, 200, { ...cached, id, folder, uid, cached: true });
        }
        const message = await cli.read(folder, uid, {
          maxChars: 12000,
          saveAttachments: save,
          saveAttachmentsDir: attachmentsDir,
        });
        if (!save) store.setBody(id, message).save();
        return json(res, 200, { ...message, id, folder, uid, cached: false });
      }
      if (req.method === 'GET' && path === '/api/team-mail/workspaces') {
        const items = ctx.workspaceRegistry.list().map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
        }));
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && path === '/api/team-mail/prompt') {
        return json(res, 200, { text: systemPromptText(current()), configured: isConfigured(current()) });
      }
      if (req.method === 'GET' && path === '/api/team-mail/credential') {
        return json(res, 200, await credentialStatus());
      }
      if (req.method === 'POST' && path === '/api/team-mail/credential') {
        const body = await readBody(req);
        return json(res, 200, await savePassword(body.value));
      }
      if (req.method === 'DELETE' && path === '/api/team-mail/credential') {
        return json(res, 200, await clearPassword());
      }
      if (req.method === 'POST' && path === '/api/team-mail/config') {
        const body = await readBody(req);
        const saved = await saveConfig(body);
        return json(res, 200, { ok: true, config: saved });
      }
      if (req.method === 'POST' && path === '/api/team-mail/verify') {
        const folders = await cli.folders();
        return json(res, 200, { ok: true, folders: folders.map((folder) => folder.name) });
      }
      if (req.method === 'POST' && path === '/api/team-mail/ack') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        for (const [folder, uids] of groupByFolder(ids)) store.ack(folder, uids);
        store.save();
        return json(res, 200, { ok: true, ids });
      }
      if (req.method === 'POST' && path === '/api/team-mail/delete') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        if (ids.length === 0) throw new Error('ids 不能为空');
        for (const [folder, uids] of groupByFolder(ids)) await cli.move(folder, uids, 'Deleted Messages');
        store.removeMessages(ids).save();
        return json(res, 200, { ok: true, ids });
      }
      if (req.method === 'POST' && path === '/api/team-mail/plant') {
        const body = await readBody(req);
        return json(res, 200, await plant(body));
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      logger.warn?.(`[dsh-team-mail] 请求失败: ${error?.message || error}`);
      return json(res, 500, { error: error?.message || String(error) });
    }
  }

  ctx.effect(() => {
    let stopped = false;
    let timer = null;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await sync(false);
        if (!stopped) schedule();
      }, current().pollSeconds * 1000);
    };
    void sync(true).finally(() => {
      if (!stopped) schedule();
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  });

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/team-mail', handler: handle }));

  for (const tool of createTeamMailTools({
    cli,
    attachmentsDir,
    store,
    config: () => current(),
  })) {
    ctx.effect(() => ctx.tools.register(tool));
  }

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'team-mail',
      order: 800,
      text: () => systemPromptText(current()),
    }),
  );

  logger.info?.(
    `[dsh-team-mail] 已启动：账号 ${current().email || '(未配置)'}，文件夹 ${current().folders.join(' / ')}，轮询 ${current().pollSeconds}s`,
  );
}
