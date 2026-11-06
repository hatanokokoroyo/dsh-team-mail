/**
 * Agent-facing mail tools. Every write/read of one message takes the explicit
 * `folder:uid` id, so "拉取最近的邮件" can never silently expand into several
 * messages or several replies.
 *
 * Tools are prefixed `team_mail_` so they cannot collide with another mail
 * plugin's `mail_*` registration in the same Agent session.
 */
import { messageId, splitId } from './mail.js';

const FOLDER = { type: 'string', description: '邮件文件夹，默认 INBOX；发件箱通常是 "Sent Messages"' };
const IDS = {
  type: 'array',
  items: { type: 'string' },
  description: '邮件 id 数组，每项形如 "INBOX:269"（文件夹:uid）',
};
const TOOL = 'team_mail_';

function stamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function envelope(row, folder) {
  const id = messageId(folder, row.uid);
  const flag = row.seen ? '已读' : '未读';
  const trusted = row.trusted === false ? ' [非白名单]' : '';
  return `${id}  ${stamp(Date.parse(row.date || ''))}  ${flag}  ${row.from || ''}  ${row.subject || '(无主题)'}${trusted}`;
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function envelopeSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      folder: { type: 'string' },
      uid: { type: 'integer' },
      from: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      date: { type: 'string' },
      seen: { type: 'boolean' },
      trusted: { type: 'boolean' },
    },
  };
}

/**
 * @param deps.cli - MailCli instance.
 * @param deps.attachmentsDir - where attachments are saved.
 * @param deps.store - MailStore (the local ack ledger).
 * @param deps.config - () => effective config (for signature-aware wording).
 */
export function createTeamMailTools({ cli, attachmentsDir, store, config }) {
  const signature = () => config?.()?.signature || '';

  return [
    {
      name: `${TOOL}folders`,
      description: '列出邮箱文件夹（名称、分隔符、标记）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          text((value.folders || []).map((f) => `${f.name}${f.flags?.length ? `  [${f.flags.join(',')}]` : ''}`).join('\n')),
      },
      async execute() {
        const folders = await cli.folders();
        return { folders };
      },
    },
    {
      name: `${TOOL}list`,
      description:
        '列邮件信封（不含正文）。可按文件夹、未读、发件人、主题、全文关键字、时间过滤。返回的每封邮件都带 folder:uid 形式的 id；读正文用 team_mail_read。',
      parameters: {
        type: 'object',
        properties: {
          folder: FOLDER,
          unseen: { type: 'boolean', description: '只看未读' },
          from: { type: 'string', description: '发件人关键字' },
          subject: { type: 'string', description: '主题关键字' },
          text: { type: 'string', description: '正文关键字（会逐封取正文，较慢）' },
          since: { type: 'string', description: '时间窗口：3d / 12h / 30m / 2026-11-01' },
          limit: { type: 'integer', description: '最多返回几封，默认 20' },
          scan: { type: 'integer', description: '本地扫描窗口，默认 300' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { messages: { type: 'array', items: envelopeSchema() } } },
        render: (_args, value) =>
          text((value.messages || []).map((m) => envelope(m, m.folder)).join('\n') || '(没有匹配的邮件)'),
      },
      async execute(args = {}) {
        const folder = args.folder || 'INBOX';
        const rows = await cli.list({ ...args, folder });
        return {
          folder,
          messages: rows.map((r) => ({ ...r, id: messageId(folder, r.uid), folder })),
        };
      },
    },
    {
      name: `${TOOL}new`,
      description:
        '列出本地还没处理过（未 ack）的收件箱邮件信封。只覆盖收件箱（默认 INBOX），不是“最近 N 封”的意思。',
      parameters: {
        type: 'object',
        properties: {
          folder: FOLDER,
          since: { type: 'string', description: '时间窗口，默认 3d' },
          limit: { type: 'integer', description: '最多返回几封，默认 100' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { messages: { type: 'array', items: envelopeSchema() } } },
        render: (_args, value) =>
          text((value.messages || []).map((m) => envelope(m, m.folder)).join('\n') || '(没有未处理的新邮件)'),
      },
      async execute(args = {}) {
        const folder = args.folder || 'INBOX';
        const rows = await cli.list({ folder, since: args.since || '3d', limit: args.limit || 100, scan: 300 });
        const fresh = rows
          .filter((row) => Number.isInteger(Number(row.uid)) && !store.isAcked(folder, row.uid))
          .sort((a, b) => Number(a.uid) - Number(b.uid));
        return {
          folder,
          messages: fresh.map((r) => ({ ...r, id: messageId(folder, r.uid), folder })),
        };
      },
    },
    {
      name: `${TOOL}read`,
      description:
        '按 id 读取一封邮件的正文与附件清单。id 必须是明确的一封，例如 "INBOX:269" 或 "Sent Messages:271"。默认不改邮件已读状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '邮件 id，形如 "INBOX:269"' },
          html: { type: 'boolean', description: '同时返回 HTML 正文' },
          maxChars: { type: 'integer', description: '正文最大字符数，默认 8000' },
          saveAttachments: { type: 'boolean', description: '把附件保存到本机专用目录并在结果中给出路径' },
          markSeen: { type: 'boolean', description: '同时把邮件标记为已读' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          text(
            [
              `${value.id}  ${value.subject || '(无主题)'}`,
              `发件人: ${value.from || ''}    时间: ${value.date || ''}`,
              value.attachments?.length
                ? `附件: ${value.attachments.map((a) => `${a.filename}（${a.size} 字节）`).join('、')}`
                : '附件: 无',
              '',
              (value.text || '').slice(0, 8000),
              value.savedAttachments?.length ? `\n已保存附件:\n${value.savedAttachments.join('\n')}` : '',
            ].filter(Boolean).join('\n'),
          ),
      },
      async execute(args = {}) {
        const { folder, uid } = splitId(args.id);
        if (!args.saveAttachments) {
          const cached = store?.getBody?.(args.id);
          if (cached) return { ...cached, id: args.id, folder, uid, cached: true };
        }
        const message = await cli.read(folder, uid, {
          html: Boolean(args.html),
          maxChars: args.maxChars ?? 8000,
          markSeen: Boolean(args.markSeen),
          saveAttachments: Boolean(args.saveAttachments),
          saveAttachmentsDir: attachmentsDir,
        });
        if (!args.saveAttachments) {
          store?.setBody?.(args.id, message);
          store?.save?.();
        }
        return { ...message, id: args.id, folder, uid, cached: false };
      },
    },
    {
      name: `${TOOL}send`,
      description: `发送一封新邮件。只在用户明确要求发送时使用；不要根据邮件内容自动发送。${
        signature() ? `落款用「${signature()}」。` : '没有配置落款时不要在末尾签署人名。'
      }`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: '收件人，至少一个' },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          html: { type: 'boolean' },
          attachments: { type: 'array', items: { type: 'string' }, description: '本机文件路径' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) =>
          text(
            `已发送：${value.subject} → ${(value.to || []).join(', ')}${
              value.refused && Object.keys(value.refused).length ? `\n被拒收件人: ${JSON.stringify(value.refused)}` : ''
            }`,
          ),
      },
      async execute(args = {}) {
        if (!Array.isArray(args.to) || args.to.length === 0) throw new Error('to 至少需要一个收件人');
        return cli.send({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          body: args.body,
          html: Boolean(args.html),
          attachments: args.attachments || [],
        });
      },
    },
    {
      name: `${TOOL}reply`,
      description: '按 id 回复一封邮件（自动带 Re: 前缀与线程头）。只在用户明确要求发送回复时使用；默认先起草给用户看。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要回复的邮件 id' },
          body: { type: 'string', description: '回复正文' },
          all: { type: 'boolean', description: '回复全部（带原 CC）' },
          quote: { type: 'boolean', description: '附上原文引用' },
          attachments: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'body'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(`已回复：${value.subject} → ${(value.replyTo || []).join(', ')}`),
      },
      async execute(args = {}) {
        const { folder, uid } = splitId(args.id);
        return cli.reply(folder, uid, {
          body: args.body,
          all: Boolean(args.all),
          quote: Boolean(args.quote),
          attachments: args.attachments || [],
        });
      },
    },
    {
      name: `${TOOL}ack`,
      description:
        '把邮件标记为“已处理”（本地 ack，与服务端已读无关），避免下次重复出现在 team_mail_new 里。只接受显式 id 数组。',
      parameters: {
        type: 'object',
        properties: { ids: IDS },
        required: ['ids'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(`已标记处理：${(value.ids || []).join(', ')}`),
      },
      async execute(args = {}) {
        const groups = groupIds(args.ids);
        for (const [folder, uids] of groups) store.ack(folder, uids);
        store.save();
        return { ids: args.ids, ok: true };
      },
    },
    {
      name: `${TOOL}mark`,
      description: '按显式 id 修改邮件已读/未读状态。',
      parameters: {
        type: 'object',
        properties: { ids: IDS, seen: { type: 'boolean', description: 'true 标记已读，false 标记未读' } },
        required: ['ids', 'seen'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(`已${value.seen ? '标记已读' : '标记未读'}：${(value.ids || []).join(', ')}`),
      },
      async execute(args = {}) {
        for (const [folder, uids] of groupIds(args.ids)) await cli.mark(folder, uids, Boolean(args.seen));
        return { ids: args.ids, seen: Boolean(args.seen), ok: true };
      },
    },
    {
      name: `${TOOL}move`,
      description: '按显式 id 把邮件移动到另一个文件夹。不可撤销，调用前先确认 id。',
      parameters: {
        type: 'object',
        properties: { ids: IDS, to: { type: 'string', description: '目标文件夹，例如 "Deleted Messages"' } },
        required: ['ids', 'to'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => text(`已移动 ${(value.ids || []).join(', ')} → ${value.to}`),
      },
      async execute(args = {}) {
        if (!args.to) throw new Error('缺少目标文件夹 to');
        for (const [folder, uids] of groupIds(args.ids)) await cli.move(folder, uids, args.to);
        return { ids: args.ids, to: args.to, ok: true };
      },
    },
  ];
}

function groupIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids 不能为空');
  const groups = new Map();
  for (const id of ids) {
    const { folder, uid } = splitId(id);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(uid);
  }
  return groups;
}

export { asText };
