/**
 * Plugin configuration: the single source of truth for the mailbox account,
 * the IMAP/SMTP servers, the sync policy, and the prompt text the Agent uses
 * when it writes mail.
 *
 * Every user-editable field is `volatile`, so a change saved from the panel
 * (or from the DSH Plugins page) is applied without a restart and is written
 * to the active profile's `cordis.patch.yml` by DSH's config editor — that is
 * the standard DSH plugin configuration scheme. Nothing here is uploaded
 * anywhere: the values live in the local profile file, and the mailbox
 * password is kept out of configuration entirely (see index.js, which stores
 * it in the local DSH credential store).
 */
import z from '@deepseek-ai/schemastery';

/** Folders merged into the timeline when the user has not chosen others. */
export const DEFAULT_FOLDERS = ['INBOX', 'Sent Messages'];

/** Credential reference holding the mailbox password (never in configuration). */
export const PASSWORD_REF = 'DSH_TEAM_MAIL_PASS';

/**
 * Configuration schema. Fields are `volatile` where the user can edit them
 * from the panel, which is what makes them live-editable and persists them
 * into the profile patch layer.
 */
export const Config = z.object({
  email: z.string().description('Mailbox address, e.g. you@example.com').volatile(),
  displayName: z.string().description('Sender display name').volatile(),
  signature: z.string().description('Signature appended to outgoing mail').volatile(),
  imapHost: z.string().description('IMAP server host').volatile(),
  imapPort: z.natural().default(993).description('IMAP port').volatile(),
  imapSecure: z.boolean().default(true).description('IMAP over TLS').volatile(),
  smtpHost: z.string().description('SMTP server host').volatile(),
  smtpPort: z.natural().default(465).description('SMTP port').volatile(),
  smtpSecure: z.boolean().default(true).description('SMTP over TLS').volatile(),
  folders: z.array(z.string()).default(DEFAULT_FOLDERS).description('Folders in the timeline').volatile(),
  pollSeconds: z.natural().default(180).description('Background sync interval in seconds').volatile(),
  prefetchLimit: z.natural().default(12).description('Bodies prefetched after each sync').volatile(),
  allowedSenders: z.array(z.string()).default([]).description('Trusted senders or domains; empty trusts everyone').volatile(),
  contacts: z.array(z.string()).default([]).description('People the Agent may address, "Name <email> — role"').volatile(),
  instructions: z.string().default('').description('Extra instructions for the Agent when writing mail').volatile(),
});

/** Read one field, accepting either a live config reference or a plain value. */
function read(config, name) {
  const ref = config?.[name];
  const value = ref && typeof ref.get === 'function' ? ref.get() : config?.[name];
  return value === undefined || value === null ? undefined : value;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function port(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

function count(value, fallback, min = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function list(value) {
  if (Array.isArray(value)) return value.map((item) => text(String(item))).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/**
 * Resolve the effective, normalized configuration from the Loader entry.
 * @param config - the config object `apply` receives (volatile values are refs).
 * @returns the values the rest of the plugin uses.
 */
export function readConfig(config = {}) {
  return {
    email: text(read(config, 'email')),
    displayName: text(read(config, 'displayName')),
    signature: text(read(config, 'signature')),
    imap: {
      host: text(read(config, 'imapHost')),
      port: port(read(config, 'imapPort'), 993),
      secure: read(config, 'imapSecure') !== false,
    },
    smtp: {
      host: text(read(config, 'smtpHost')),
      port: port(read(config, 'smtpPort'), 465),
      secure: read(config, 'smtpSecure') !== false,
    },
    folders: list(read(config, 'folders')).length ? list(read(config, 'folders')) : [...DEFAULT_FOLDERS],
    pollSeconds: Math.max(30, count(read(config, 'pollSeconds'), 180, 30)),
    prefetchLimit: count(read(config, 'prefetchLimit'), 12),
    allowedSenders: list(read(config, 'allowedSenders')),
    contacts: list(read(config, 'contacts')),
    instructions: String(read(config, 'instructions') || '').trim(),
  };
}

/** Whether enough is configured for the mailbox to be usable at all. */
export function isConfigured(cfg) {
  return Boolean(cfg.email && cfg.imap.host && cfg.smtp.host);
}

/** Merge a partial edit from the panel onto the current configuration. */
export function mergeConfig(cfg, patch = {}) {
  const next = {
    email: text(patch.email ?? cfg.email),
    displayName: text(patch.displayName ?? cfg.displayName),
    signature: text(patch.signature ?? cfg.signature),
    imapHost: text(patch.imapHost ?? cfg.imap.host),
    imapPort: port(patch.imapPort ?? cfg.imap.port, 993),
    imapSecure: (patch.imapSecure ?? cfg.imap.secure) !== false,
    smtpHost: text(patch.smtpHost ?? cfg.smtp.host),
    smtpPort: port(patch.smtpPort ?? cfg.smtp.port, 465),
    smtpSecure: (patch.smtpSecure ?? cfg.smtp.secure) !== false,
    folders: list(patch.folders ?? cfg.folders),
    pollSeconds: Math.max(30, count(patch.pollSeconds ?? cfg.pollSeconds, 180, 30)),
    prefetchLimit: count(patch.prefetchLimit ?? cfg.prefetchLimit, 12),
    allowedSenders: list(patch.allowedSenders ?? cfg.allowedSenders),
    contacts: list(patch.contacts ?? cfg.contacts),
    instructions: String(patch.instructions ?? cfg.instructions).trim(),
  };
  validate(next);
  return next;
}

/** Throw a readable error for values the mailbox cannot work with. */
export function validate(cfg) {
  if (cfg.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.email)) {
    throw new Error(`邮箱地址无效：${cfg.email}`);
  }
  if (cfg.email && !cfg.imap.host) throw new Error('请填写 IMAP 服务器地址');
  if (cfg.email && !cfg.smtp.host) throw new Error('请填写 SMTP 服务器地址');
  if (!cfg.folders.length) throw new Error('至少需要一个文件夹');
}

/** What the panel may see: everything except the password. */
export function publicConfig(cfg) {
  return {
    email: cfg.email,
    displayName: cfg.displayName,
    signature: cfg.signature,
    imapHost: cfg.imap.host,
    imapPort: cfg.imap.port,
    imapSecure: cfg.imap.secure,
    smtpHost: cfg.smtp.host,
    smtpPort: cfg.smtp.port,
    smtpSecure: cfg.smtp.secure,
    folders: cfg.folders,
    pollSeconds: cfg.pollSeconds,
    prefetchLimit: cfg.prefetchLimit,
    allowedSenders: cfg.allowedSenders,
    contacts: cfg.contacts,
    instructions: cfg.instructions,
    configured: isConfigured(cfg),
  };
}

/**
 * Environment handed to the bundled Python engine for one invocation. The
 * engine never reads a configuration file of its own, so the panel and the
 * CLI cannot drift apart.
 */
export function cliEnv(cfg, password) {
  return {
    DSH_TEAM_MAIL_USER: cfg.email,
    DSH_TEAM_MAIL_PASS: password || '',
    DSH_TEAM_MAIL_IMAP_HOST: cfg.imap.host,
    DSH_TEAM_MAIL_IMAP_PORT: String(cfg.imap.port),
    DSH_TEAM_MAIL_IMAP_SSL: cfg.imap.secure ? '1' : '0',
    DSH_TEAM_MAIL_SMTP_HOST: cfg.smtp.host,
    DSH_TEAM_MAIL_SMTP_PORT: String(cfg.smtp.port),
    DSH_TEAM_MAIL_SMTP_SSL: cfg.smtp.secure ? '1' : '0',
    DSH_TEAM_MAIL_FROM_NAME: cfg.displayName,
    DSH_TEAM_MAIL_SIGNATURE: cfg.signature,
    DSH_TEAM_MAIL_ALLOWED: cfg.allowedSenders.join(','),
  };
}
