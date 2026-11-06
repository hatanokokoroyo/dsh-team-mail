/**
 * Durable cache for the mail panel: message envelopes per folder, the
 * per-folder uid watermark used for incremental sync, the local "already
 * handled" (ack) ledger, and the session ↔ email bindings created by
 * "交给 Agent".
 *
 * This is a derived cache, not the source of truth: the mailbox wins, and
 * bindings are also implied by the prompt text stored in the Session log.
 * The ack ledger is deliberately local-only: whether a message was handled is
 * the mailbox owner's decision, so it is never written back to the server.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const STATE_VERSION = 1;

export function defaultStateFile() {
  return join(homedir(), '.local', 'share', 'dsh-team-mail', 'state.json');
}

function parseTimestamp(date, internalDate) {
  const direct = Date.parse(date || '');
  if (Number.isFinite(direct)) return direct;
  const imap = Date.parse(internalDate || '');
  return Number.isFinite(imap) ? imap : 0;
}

export class MailStore {
  constructor(file = defaultStateFile(), { maxPerFolder = 400 } = {}) {
    this.file = file;
    this.maxPerFolder = maxPerFolder;
    this.data = { version: STATE_VERSION, folders: {}, bindings: {}, bodies: {}, acks: {}, lastSync: 0 };
  }

  load() {
    try {
      if (!existsSync(this.file)) return this;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === STATE_VERSION) {
        this.data = {
          version: STATE_VERSION,
          folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {},
          bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
          bodies: parsed.bodies && typeof parsed.bodies === 'object' ? parsed.bodies : {},
          acks: parsed.acks && typeof parsed.acks === 'object' ? parsed.acks : {},
          lastSync: Number(parsed.lastSync) || 0,
        };
      }
    } catch {
      /* a corrupt cache is not fatal: it is rebuilt from the mailbox */
    }
    return this;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  folder(folder) {
    return this.data.folders[folder] ?? { lastUid: 0, messages: [] };
  }

  /** Merge freshly fetched envelopes, keeping the newest `maxPerFolder` per folder. */
  merge(folder, rows, { trusted } = {}) {
    const current = this.folder(folder);
    const byUid = new Map(current.messages.map((m) => [m.uid, m]));
    for (const row of rows) {
      const uid = Number(row.uid);
      if (!Number.isInteger(uid) || uid <= 0) continue;
      byUid.set(uid, {
        id: `${folder}:${uid}`,
        folder,
        uid,
        from: row.from || '',
        to: row.to || '',
        subject: row.subject || '',
        date: row.date || '',
        ts: parseTimestamp(row.date, row.internalDate),
        messageId: row.messageId || '',
        references: row.references || '',
        inReplyTo: row.inReplyTo || '',
        size: row.size ?? null,
        internalDate: row.internalDate || '',
        seen: Boolean(row.seen),
        flags: Array.isArray(row.flags) ? row.flags : [],
        trusted: typeof trusted === 'function' ? trusted(row.from || '') : true,
      });
    }
    const messages = [...byUid.values()].sort((a, b) => b.uid - a.uid).slice(0, this.maxPerFolder);
    this.data.folders[folder] = {
      lastUid: Math.max(current.lastUid || 0, ...rows.map((r) => Number(r.uid) || 0)),
      messages,
    };
    this.pruneBodies();
    return this;
  }

  setLastSync(ts) {
    this.data.lastSync = ts;
    return this;
  }

  get lastSync() {
    return this.data.lastSync || 0;
  }

  allMessages() {
    const out = [];
    for (const folder of Object.keys(this.data.folders)) out.push(...(this.data.folders[folder].messages || []));
    return out.sort((a, b) => b.ts - a.ts || b.uid - a.uid);
  }

  // ---------------------------------------------------------------- ack ledger

  /** Mark messages handled locally (no IMAP flags are touched). */
  ack(folder, uids) {
    const set = new Set(this.data.acks[folder] || []);
    for (const uid of uids) {
      const n = Number(uid);
      if (Number.isInteger(n) && n > 0) set.add(n);
    }
    this.data.acks[folder] = [...set].sort((a, b) => a - b);
    return this;
  }

  isAcked(folder, uid) {
    return (this.data.acks[folder] || []).includes(Number(uid));
  }

  /** Whether a message that arrived since `sinceMs` is still unhandled. */
  hasUnacked(folder = 'INBOX') {
    return this.folder(folder).messages.some((m) => !this.isAcked(folder, m.uid));
  }

  // ---------------------------------------------------------------- bindings

  bind(sessionId, binding) {
    this.data.bindings[sessionId] = { ...binding, at: Date.now() };
    return this;
  }

  unbind(sessionId) {
    delete this.data.bindings[sessionId];
    return this;
  }

  /** Most recent session a given email was handed to, if any. */
  bindingFor(id) {
    let best;
    for (const [sessionId, binding] of Object.entries(this.data.bindings)) {
      if (!binding || binding.id !== id) continue;
      if (!best || (binding.at || 0) > (best.at || 0)) best = { sessionId, ...binding };
    }
    return best;
  }

  bindingOfSession(sessionId) {
    return this.data.bindings[sessionId];
  }

  /** Remove deleted messages from the envelope cache and the body cache. */
  removeMessages(ids) {
    const set = new Set(ids);
    for (const folder of Object.keys(this.data.folders)) {
      const state = this.data.folders[folder];
      const removed = (state.messages || []).filter((m) => set.has(m.id)).map((m) => m.uid);
      state.messages = (state.messages || []).filter((m) => !set.has(m.id));
      if (removed.length > 0 && this.data.acks[folder]) {
        this.data.acks[folder] = this.data.acks[folder].filter((uid) => !removed.includes(uid));
      }
    }
    for (const id of set) delete this.data.bodies[id];
    return this;
  }

  /** Full body cache, so opening a message is not an IMAP round-trip. */
  getBody(id) {
    return this.data.bodies[id];
  }

  setBody(id, message) {
    this.data.bodies[id] = {
      text: String(message.text || ''),
      html: typeof message.html === 'string' ? message.html : '',
      attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
      subject: message.subject || '',
      from: message.from || '',
      to: message.to || '',
      date: message.date || '',
      messageId: message.messageId || '',
      references: message.references || '',
      inReplyTo: message.inReplyTo || '',
      readAt: Date.now(),
    };
    this.pruneBodies();
    return this;
  }

  /** Drop bodies whose envelope left the cache, then cap the map size. */
  pruneBodies() {
    const live = new Set(this.allMessages().map((m) => m.id));
    for (const id of Object.keys(this.data.bodies)) {
      if (!live.has(id)) delete this.data.bodies[id];
    }
    const ids = Object.keys(this.data.bodies);
    if (ids.length > 600) {
      ids.sort((a, b) => (this.data.bodies[a].readAt || 0) - (this.data.bodies[b].readAt || 0));
      for (const id of ids.slice(0, ids.length - 600)) delete this.data.bodies[id];
    }
  }
}
