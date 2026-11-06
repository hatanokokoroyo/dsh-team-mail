window.__ModuleLoader__.load({
  id: 'dsh-team-mail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/api/team-mail';
    const WORKSPACE_KEY = 'dsh-team-mail.workspace';
    const TEMPLATES = [
      ['summary', '总结要点'],
      ['reply', '起草回复（等我确认）'],
      ['execute', '按邮件任务执行'],
      ['custom', '自定义'],
    ];

    let app = null;

    async function request(path, options = {}) {
      const response = await fetch(API + path, {
        method: options.method || 'GET',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin',
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      return payload;
    }

    function pad(n) {
      return String(n).padStart(2, '0');
    }

    function formatDate(ts) {
      if (!ts) return '';
      const date = new Date(ts);
      const now = new Date();
      if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      if (date.getFullYear() === now.getFullYear()) {
        return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    const CSS = `
.dsh-mail-root{height:100%;min-height:0;flex:1;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow:hidden}
.dsh-mail-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-mail-title{font-size:14px;font-weight:600;margin:0}
.dsh-mail-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-mail-spacer{flex:1}
.dsh-mail-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-mail-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsh-mail-btn:disabled{opacity:.5;cursor:default}
.dsh-mail-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsh-mail-btn.danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.dsh-mail-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dsh-mail-btn.ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-mail-tabs{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;flex:none}
.dsh-mail-tab{height:26px;padding:0 10px;border:0;border-radius:13px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsh-mail-tab:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-mail-tab.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-mail-search{height:28px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;width:180px}
.dsh-mail-search:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-mail-body{flex:1;min-height:0;display:flex}
.dsh-mail-list{width:360px;flex:none;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1)}
.dsh-mail-row{display:flex;align-items:flex-start;gap:8px;width:100%;padding:10px 14px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dsh-mail-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dsh-mail-check{flex:none;width:14px;height:14px;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-mail-remember{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:14px}
.dsh-mail-remember input{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-mail-selectall{flex:none;width:14px;height:14px;margin:0 6px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-mail-batch{display:flex;align-items:center;gap:8px;padding:7px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none;font-size:12px}
.dsh-mail-batch .dsh-mail-sub{margin:0}
.dsh-mail-row:hover{background:var(--dsw-alias-bg-layer-1)}
.dsh-mail-row.active{background:var(--dsw-alias-bg-layer-2)}
.dsh-mail-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mail-dir{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mail-dir.in{color:var(--dsw-alias-brand-primary)}
.dsh-mail-who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mail-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-mail-subject{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dsh-mail-row.unread .dsh-mail-subject{font-weight:600}
.dsh-mail-chips{display:flex;gap:6px;flex-wrap:wrap}
.dsh-mail-chip{font-size:10px;line-height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsh-mail-chip.warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-mail-chip.ok{color:var(--dsw-alias-state-success-primary)}
.dsh-mail-chip.brand{color:var(--dsw-alias-brand-primary)}
.dsh-mail-detail{flex:1;min-width:0;overflow-y:auto;padding:18px 24px 40px}
.dsh-mail-detail h2{font-size:17px;line-height:1.4;margin:0 0 10px;font-weight:600}
.dsh-mail-meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:14px}
.dsh-mail-actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 18px}
.dsh-mail-text{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.dsh-mail-attach{margin-top:18px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;font-size:12px}
.dsh-mail-attach ul{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary)}
.dsh-mail-empty{display:flex;flex:1;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;padding:40px}
.dsh-mail-banner{margin:8px 16px 0;padding:8px 10px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
.dsh-mail-badge{position:absolute;top:-3px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:600}
.dsh-mail-icon{position:relative;display:inline-flex;align-items:center;justify-content:center}
.dsh-mail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px;box-sizing:border-box}
.dsh-mail-modal{width:480px;max-width:calc(100vw - 48px);max-height:calc(100vh - 48px);overflow-y:auto;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:18px 20px;box-shadow:0 16px 48px rgba(0,0,0,.35)}
.dsh-mail-modal h3{margin:0 0 4px;font-size:15px}
.dsh-mail-modal .dsh-mail-sub{margin-bottom:14px;display:block}
.dsh-mail-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.dsh-mail-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mail-field select,.dsh-mail-field textarea,.dsh-mail-field input[type=text],.dsh-mail-field input[type=password],.dsh-mail-field input[type=number]{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 8px;outline:none}
.dsh-mail-field textarea{min-height:70px;resize:vertical}
.dsh-mail-field select:focus,.dsh-mail-field textarea:focus,.dsh-mail-field input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-mail-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.dsh-mail-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsh-mail-section{margin:16px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
.dsh-mail-section:first-child{border-top:0;padding-top:0;margin-top:4px}
.dsh-mail-pre{white-space:pre-wrap;word-break:break-word;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px;max-height:220px;overflow:auto;color:var(--dsw-alias-label-secondary)}
.dsh-mail-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.dsh-mail-err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dsh-mail-wide{width:680px}
.dsh-mail-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:10px;line-height:1.5}
`;

    function Button({ children, onClick, primary, ghost, danger, disabled, title }) {
      const className = ['dsh-mail-btn', primary ? 'primary' : '', ghost ? 'ghost' : '', danger ? 'danger' : '']
        .filter(Boolean)
        .join(' ');
      return h('button', { type: 'button', className, onClick, disabled, title }, children);
    }

    function Chip({ children, tone }) {
      return h('span', { className: `dsh-mail-chip ${tone || ''}` }, children);
    }

    function MailIcon(props) {
      const [count, setCount] = useState(0);
      useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const snapshot = await request('/snapshot');
            if (alive) setCount((snapshot && snapshot.counts && snapshot.counts.unprocessed) || 0);
          } catch {
            /* badge failures stay silent */
          }
        };
        load();
        const timer = setInterval(load, 120000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      const size = (props && props.size) || 16;
      // Inline styles only: the sidebar renders this glyph before the panel's
      // stylesheet exists, so the icon must not depend on any class.
      const badge =
        count > 0
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  top: -4,
                  right: -5,
                  minWidth: 11,
                  height: 11,
                  padding: '0 1.5px',
                  borderRadius: 6,
                  background: 'var(--dsw-alias-state-error-primary)',
                  color: '#fff',
                  fontSize: 8,
                  lineHeight: '11px',
                  fontWeight: 700,
                  textAlign: 'center',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                },
              },
              count > 99 ? '99+' : String(count),
            )
          : null;
      return h(
        'span',
        {
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            flex: 'none',
          },
        },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
          h('path', { d: 'M3.5 6.5 12 13l8.5-6.5' }),
        ),
        badge,
      );
    }

    function MailPanel() {
      const [snapshot, setSnapshot] = useState(null);
      const [filter, setFilter] = useState('unprocessed');
      const [query, setQuery] = useState('');
      const [selectedId, setSelectedId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [handoff, setHandoff] = useState(null);
      const [selectedIds, setSelectedIds] = useState([]);
      const [confirmDelete, setConfirmDelete] = useState(null);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const selectAllRef = useRef(null);

      const load = useCallback(async (force) => {
        try {
          const next = await request(force ? '/refresh' : '/snapshot', { method: force ? 'POST' : 'GET' });
          setSnapshot(next);
          setError('');
        } catch (cause) {
          setError(cause.message || String(cause));
        }
      }, []);

      useEffect(() => {
        load(true);
        const timer = setInterval(() => load(false), 30000);
        return () => clearInterval(timer);
      }, [load]);

      useEffect(() => {
        if (!selectedId) {
          setDetail(null);
          return;
        }
        let alive = true;
        setDetailLoading(true);
        request(`/message?id=${encodeURIComponent(selectedId)}`)
          .then((message) => {
            if (alive) setDetail(message);
          })
          .catch((cause) => {
            if (alive) setError(cause.message || String(cause));
          })
          .finally(() => {
            if (alive) setDetailLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [selectedId]);

      const rows = useMemo(() => {
        const messages = (snapshot && snapshot.messages) || [];
        const needle = query.trim().toLowerCase();
        return messages.filter((message) => {
          if (filter === 'inbox' && message.direction !== 'in') return false;
          if (filter === 'sent' && message.direction !== 'out') return false;
          if (filter === 'unprocessed' && !(message.direction === 'in' && !message.processed)) return false;
          if (!needle) return true;
          return `${message.subject || ''} ${message.from || ''} ${message.to || ''}`.toLowerCase().includes(needle);
        });
      }, [snapshot, filter, query]);

      const counts = (snapshot && snapshot.counts) || { unprocessed: 0, inbox: 0, sent: 0 };
      const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(row.id));

      useEffect(() => {
        if (selectAllRef.current) {
          selectAllRef.current.indeterminate = selectedIds.length > 0 && !allVisibleSelected;
        }
      }, [selectedIds, allVisibleSelected]);

      function toggleSelect(id) {
        setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
      }

      function toggleSelectAll() {
        setSelectedIds(allVisibleSelected ? [] : rows.map((row) => row.id));
      }

      async function batchAck() {
        if (selectedIds.length === 0) return;
        setBusy(true);
        try {
          await request('/ack', { method: 'POST', body: { ids: selectedIds } });
          setSelectedIds([]);
          await load(true);
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      }

      async function doDelete(ids) {
        setBusy(true);
        try {
          await request('/delete', { method: 'POST', body: { ids } });
          if (selectedId && ids.includes(selectedId)) setSelectedId(null);
          setSelectedIds((prev) => prev.filter((value) => !ids.includes(value)));
          setConfirmDelete(null);
          await load(true);
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      }

      async function markProcessed(id) {
        setBusy(true);
        try {
          await request('/ack', { method: 'POST', body: { ids: [id] } });
          await load(true);
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      }

      async function openHandoff(message) {
        setBusy(true);
        try {
          const list = await request('/workspaces');
          const remembered = localStorage.getItem(WORKSPACE_KEY);
          const items = (list && list.items) || [];
          const workspaceId = items.some((item) => item.id === remembered) ? remembered : items[0]?.id;
          setHandoff({ message, items, workspaceId, template: 'summary', instruction: '', remember: true });
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      }

      async function submitHandoff() {
        if (!handoff || !handoff.workspaceId) return;
        setHandoff({ ...handoff, busy: true });
        try {
          const sessionId = await app.uiWorkspace.connectWorkspace(handoff.workspaceId);
          const result = await request('/plant', {
            method: 'POST',
            body: {
              id: handoff.message.id,
              sessionId,
              template: handoff.template,
              instruction: handoff.instruction,
              clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
          if (handoff.remember) localStorage.setItem(WORKSPACE_KEY, handoff.workspaceId);
          setHandoff(null);
          app.layout.selectPanel('conversation');
          app.uiWorkspace.openSession(result.sessionId || sessionId);
          await load(false);
        } catch (cause) {
          setHandoff({ ...handoff, busy: false });
          setError(cause.message || String(cause));
        }
      }

      async function saveAttachments() {
        if (!detail) return;
        setBusy(true);
        try {
          const message = await request(`/message?id=${encodeURIComponent(detail.id)}&save=1`);
          setDetail({ ...detail, savedAttachments: message.savedAttachments || [] });
        } catch (cause) {
          setError(cause.message || String(cause));
        } finally {
          setBusy(false);
        }
      }

      const active = rows.find((row) => row.id === selectedId) || null;

      return h(
        'div',
        { className: 'dsh-mail-root' },
        h(
          'div',
          { className: 'dsh-mail-head' },
          h('h1', { className: 'dsh-mail-title' }, '邮件'),
          h(
            'span',
            { className: 'dsh-mail-sub' },
            snapshot && snapshot.account && snapshot.account.user
              ? `${snapshot.account.user} · 待处理 ${counts.unprocessed}`
              : '未配置邮箱',
          ),
          snapshot && snapshot.syncing ? h('span', { className: 'dsh-mail-sub' }, '同步中…') : null,
          h('span', { className: 'dsh-mail-spacer' }),
          h('button', { type: 'button', className: 'dsh-mail-btn ghost', onClick: () => setSettingsOpen(true), disabled: busy }, '设置'),
          h('button', { type: 'button', className: 'dsh-mail-btn ghost', onClick: () => load(true), disabled: busy }, '刷新'),
        ),
        error ? h('div', { className: 'dsh-mail-banner' }, error) : null,
        snapshot && snapshot.configured === false
          ? h(
              'div',
              { className: 'dsh-mail-banner', style: { background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)', color: 'var(--dsw-alias-brand-primary)' } },
              '还没有配置邮箱。',
              h('button', { type: 'button', className: 'dsh-mail-btn', style: { marginLeft: '10px' }, onClick: () => setSettingsOpen(true) }, '打开设置'),
            )
          : null,
        h(
          'div',
          { className: 'dsh-mail-tabs' },
          h('input', {
            ref: selectAllRef,
            type: 'checkbox',
            className: 'dsh-mail-selectall',
            checked: allVisibleSelected,
            onChange: toggleSelectAll,
            'aria-label': '全选当前列表',
          }),
          ...[
            ['unprocessed', `待处理 ${counts.unprocessed}`],
            ['all', '全部'],
            ['inbox', `收件 ${counts.inbox}`],
            ['sent', `发件 ${counts.sent}`],
          ].map(([value, label]) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: `dsh-mail-tab ${filter === value ? 'active' : ''}`,
                onClick: () => setFilter(value),
              },
              label,
            ),
          ),
          h('span', { className: 'dsh-mail-spacer' }),
          h('input', {
            className: 'dsh-mail-search',
            placeholder: '搜索主题 / 发件人',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        selectedIds.length > 0
          ? h(
              'div',
              { className: 'dsh-mail-batch' },
              h('span', { className: 'dsh-mail-sub' }, `已选 ${selectedIds.length} 封`),
              h(Button, { onClick: batchAck, disabled: busy }, '标记已处理'),
              h(Button, { danger: true, onClick: () => setConfirmDelete({ ids: selectedIds.slice() }), disabled: busy }, '删除'),
              h(Button, { ghost: true, onClick: () => setSelectedIds([]), disabled: busy }, '取消选择'),
            )
          : null,
        h(
          'div',
          { className: 'dsh-mail-body' },
          h(
            'div',
            { className: 'dsh-mail-list' },
            rows.length === 0
              ? h('div', { className: 'dsh-mail-empty' }, filter === 'unprocessed' ? '没有待处理的邮件' : '没有邮件')
              : rows.map((message) =>
                  h(
                    'div',
                    {
                      key: message.id,
                      role: 'button',
                      tabIndex: 0,
                      className: `dsh-mail-row ${message.id === selectedId ? 'active' : ''} ${!message.seen && message.direction === 'in' ? 'unread' : ''}`,
                      onClick: () => setSelectedId(message.id),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(message.id);
                        }
                      },
                    },
                    h('input', {
                      type: 'checkbox',
                      className: 'dsh-mail-check',
                      checked: selectedIds.includes(message.id),
                      'aria-label': `选择 ${message.id}`,
                      onClick: (event) => event.stopPropagation(),
                      onChange: () => toggleSelect(message.id),
                    }),
                    h(
                      'div',
                      { className: 'dsh-mail-row-main' },
                      h(
                        'div',
                        { className: 'dsh-mail-row-top' },
                        h('span', { className: `dsh-mail-dir ${message.direction}` }, message.direction === 'in' ? '收' : '发'),
                        h(
                          'span',
                          { className: 'dsh-mail-who' },
                          message.direction === 'in' ? message.from || '(未知发件人)' : `我 → ${message.to || ''}`,
                        ),
                        h('span', { className: 'dsh-mail-time' }, formatDate(message.ts)),
                      ),
                      h('div', { className: 'dsh-mail-subject' }, message.subject || '(无主题)'),
                      h(
                        'div',
                        { className: 'dsh-mail-chips' },
                        !message.seen && message.direction === 'in' ? h(Chip, { tone: 'brand' }, '未读') : null,
                        message.direction === 'in' && !message.processed ? h(Chip, { tone: 'warn' }, '待处理') : null,
                        message.boundSessionId ? h(Chip, { tone: 'ok' }, '已交给会话') : null,
                        message.trusted === false ? h(Chip, { tone: 'warn' }, '非白名单') : null,
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'dsh-mail-detail' },
            !active
              ? h('div', { className: 'dsh-mail-empty' }, '选择左侧一封邮件查看')
              : h(
                  React.Fragment,
                  null,
                  h('h2', null, active.subject || '(无主题)'),
                  h(
                    'div',
                    { className: 'dsh-mail-meta' },
                    h('span', null, `发件人：${active.from || ''}`),
                    h('span', null, `收件人：${active.to || ''}`),
                    h('span', null, active.date || ''),
                    h('span', null, active.id),
                  ),
                  h(
                    'div',
                    { className: 'dsh-mail-actions' },
                    h(Button, { primary: true, onClick: () => openHandoff(active), disabled: busy }, '交给 Agent'),
                    active.direction === 'in' && !active.processed
                      ? h(Button, { onClick: () => markProcessed(active.id), disabled: busy }, '标记已处理')
                      : null,
                    h(Button, { danger: true, onClick: () => setConfirmDelete({ ids: [active.id] }), disabled: busy }, '删除'),
                    active.boundSessionId
                      ? h(
                          Button,
                          {
                            ghost: true,
                            onClick: () => {
                              app.layout.selectPanel('conversation');
                              app.uiWorkspace.openSession(active.boundSessionId);
                            },
                          },
                          '打开处理会话',
                        )
                      : null,
                  ),
                  detailLoading ? h('div', { className: 'dsh-mail-sub' }, '加载正文…') : null,
                  detail && detail.id === active.id
                    ? h(
                        React.Fragment,
                        null,
                        h('div', { className: 'dsh-mail-text' }, detail.text || '(正文为空)'),
                        detail.attachments && detail.attachments.length > 0
                          ? h(
                              'div',
                              { className: 'dsh-mail-attach' },
                              h('div', null, `附件（${detail.attachments.length}）`),
                              h(
                                'ul',
                                null,
                                ...detail.attachments.map((file, index) =>
                                  h('li', { key: index }, `${file.filename} · ${file.size ?? '?'} 字节`),
                                ),
                              ),
                              h(Button, { onClick: saveAttachments, disabled: busy }, '保存附件到本机'),
                              detail.savedAttachments && detail.savedAttachments.length > 0
                                ? h(
                                    'ul',
                                    null,
                                    ...detail.savedAttachments.map((path, index) => h('li', { key: index }, path)),
                                  )
                                : null,
                            )
                          : null,
                      )
                    : null,
                ),
          ),
        ),
        handoff ? h(Handoff, { state: handoff, onChange: setHandoff, onCancel: () => setHandoff(null), onSubmit: submitHandoff }) : null,
        confirmDelete
          ? h(ConfirmDelete, {
              count: confirmDelete.ids.length,
              busy,
              onCancel: () => setConfirmDelete(null),
              onConfirm: () => doDelete(confirmDelete.ids),
            })
          : null,
        settingsOpen
          ? h(SettingsModal, {
              snapshot,
              onClose: () => setSettingsOpen(false),
              onSaved: () => {
                load(true);
              },
            })
          : null,
      );
    }

    function SettingsModal({ snapshot, onClose, onSaved }) {
      const cfg = (snapshot && snapshot.config) || {};
      const [form, setForm] = useState({
        email: cfg.email || '',
        displayName: cfg.displayName || '',
        signature: cfg.signature || '',
        imapHost: cfg.imapHost || '',
        imapPort: String(cfg.imapPort ?? 993),
        imapSecure: cfg.imapSecure !== false,
        smtpHost: cfg.smtpHost || '',
        smtpPort: String(cfg.smtpPort ?? 465),
        smtpSecure: cfg.smtpSecure !== false,
        folders: (cfg.folders || []).join(', '),
        pollSeconds: String(cfg.pollSeconds ?? 180),
        prefetchLimit: String(cfg.prefetchLimit ?? 12),
        allowedSenders: (cfg.allowedSenders || []).join(', '),
        contacts: (cfg.contacts || []).join('\n'),
        instructions: cfg.instructions || '',
      });
      const [password, setPassword] = useState('');
      const [credential, setCredential] = useState((snapshot && snapshot.credential) || {});
      const [preview, setPreview] = useState('');
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);

      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
      const toggle = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.checked }));

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onClose]);

      useEffect(() => {
        request('/prompt')
          .then((data) => setPreview(data.text || ''))
          .catch(() => setPreview(''));
      }, []);

      function payload() {
        return {
          email: form.email.trim(),
          displayName: form.displayName.trim(),
          signature: form.signature,
          imapHost: form.imapHost.trim(),
          imapPort: Number(form.imapPort) || 993,
          imapSecure: Boolean(form.imapSecure),
          smtpHost: form.smtpHost.trim(),
          smtpPort: Number(form.smtpPort) || 465,
          smtpSecure: Boolean(form.smtpSecure),
          folders: form.folders.split(',').map((item) => item.trim()).filter(Boolean),
          pollSeconds: Number(form.pollSeconds) || 180,
          prefetchLimit: Number(form.prefetchLimit) || 12,
          allowedSenders: form.allowedSenders.split(',').map((item) => item.trim()).filter(Boolean),
          contacts: form.contacts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
          instructions: form.instructions,
        };
      }

      async function save(thenVerify) {
        setBusy(true);
        setStatus(null);
        try {
          await request('/config', { method: 'POST', body: payload() });
          if (password.trim()) {
            const next = await request('/credential', { method: 'POST', body: { value: password } });
            setCredential(next || {});
            setPassword('');
          }
          const data = await request('/prompt');
          setPreview(data.text || '');
          if (thenVerify) {
            const result = await request('/verify', { method: 'POST' });
            setStatus({ tone: 'dsh-mail-ok', text: `连接成功，共 ${(result.folders || []).length} 个文件夹：${(result.folders || []).join('、')}` });
          } else {
            setStatus({ tone: 'dsh-mail-ok', text: '已保存到本地 profile 配置' });
            if (onSaved) onSaved();
          }
        } catch (cause) {
          setStatus({ tone: 'dsh-mail-err', text: cause.message || String(cause) });
        } finally {
          setBusy(false);
        }
      }

      async function clearPassword() {
        setBusy(true);
        setStatus(null);
        try {
          const next = await request('/credential', { method: 'DELETE' });
          setCredential(next || {});
          setStatus({ tone: 'dsh-mail-ok', text: '已清除本地保存的密码' });
        } catch (cause) {
          setStatus({ tone: 'dsh-mail-err', text: cause.message || String(cause) });
        } finally {
          setBusy(false);
        }
      }

      const field = (label, key, type, placeholder) =>
        h(
          'div',
          { className: 'dsh-mail-field' },
          h('label', null, label),
          h('input', {
            type: type || 'text',
            value: form[key],
            placeholder: placeholder || '',
            onChange: set(key),
            autoComplete: 'off',
          }),
        );

      return h(
        'div',
        { className: 'dsh-mail-overlay', onClick: (event) => event.target === event.currentTarget && onClose() },
        h(
          'div',
          { className: 'dsh-mail-modal dsh-mail-wide' },
          h('h3', null, '邮件插件设置'),
          h('span', { className: 'dsh-mail-sub' }, '所有配置只保存在本机 profile（cordis.patch.yml），密码保存在本地凭据库，不会上传。'),
          h('div', { className: 'dsh-mail-section' }, '账号与落款'),
          h(
            'div',
            { className: 'dsh-mail-grid' },
            field('邮箱地址', 'email', 'text', 'you@example.com'),
            field('发件人显示名', 'displayName', 'text', '例如 张三'),
          ),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, '落款签名（自动加到每封新邮件末尾）'),
            h('input', { type: 'text', value: form.signature, placeholder: '例如 小张的Agent', onChange: set('signature'), autoComplete: 'off' }),
          ),
          h('div', { className: 'dsh-mail-section' }, '收发服务器'),
          h(
            'div',
            { className: 'dsh-mail-grid' },
            field('IMAP 服务器', 'imapHost', 'text', 'imap.example.com'),
            field('IMAP 端口', 'imapPort', 'number', '993'),
          ),
          h(
            'div',
            { className: 'dsh-mail-remember' },
            h('input', { type: 'checkbox', checked: form.imapSecure, onChange: toggle('imapSecure') }),
            'IMAP 使用 TLS（993 通常勾选）',
          ),
          h(
            'div',
            { className: 'dsh-mail-grid' },
            field('SMTP 服务器', 'smtpHost', 'text', 'smtp.example.com'),
            field('SMTP 端口', 'smtpPort', 'number', '465'),
          ),
          h(
            'div',
            { className: 'dsh-mail-remember' },
            h('input', { type: 'checkbox', checked: form.smtpSecure, onChange: toggle('smtpSecure') }),
            'SMTP 使用 TLS（465 通常勾选；587 一般取消）',
          ),
          h('div', { className: 'dsh-mail-section' }, '密码'),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, credential.configured ? '已保存密码（留空则不修改）' : '邮箱密码 / 客户端授权码'),
            h('input', {
              type: 'password',
              value: password,
              placeholder: credential.configured ? '••••••••（已保存）' : '客户端授权码，不是网页登录密码',
              onChange: (event) => setPassword(event.target.value),
              autoComplete: 'new-password',
            }),
          ),
          h(
            'div',
            { className: 'dsh-mail-remember' },
            h('span', { className: 'dsh-mail-sub' }, credential.configured ? '状态：已配置' : '状态：未配置'),
            h(Button, { ghost: true, onClick: clearPassword, disabled: busy || !credential.configured }, '清除已保存密码'),
          ),
          h('div', { className: 'dsh-mail-section' }, '同步'),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, '文件夹（逗号分隔）'),
            h('input', { type: 'text', value: form.folders, onChange: set('folders'), autoComplete: 'off' }),
          ),
          h(
            'div',
            { className: 'dsh-mail-grid' },
            field('同步间隔（秒）', 'pollSeconds', 'number', '180'),
            field('后台预取封数', 'prefetchLimit', 'number', '12'),
          ),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, '可信发件人 / 域名（逗号分隔，留空表示全部信任）'),
            h('input', { type: 'text', value: form.allowedSenders, placeholder: '@example.com, boss@example.com', onChange: set('allowedSenders'), autoComplete: 'off' }),
          ),
          h('div', { className: 'dsh-mail-section' }, '写邮件提示词'),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, '同事通讯录（每行一条，格式：姓名 <邮箱> — 角色）'),
            h('textarea', { value: form.contacts, placeholder: '张三 <zhangsan@example.com> — 前端', onChange: set('contacts') }),
          ),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', null, '格式 / 风格要求（会追加到 Agent 的系统提示，优先级高于通用约定）'),
            h('textarea', {
              value: form.instructions,
              placeholder: '例如：邮件用中文；先给结论再给细节；不超过 300 字；不要用「我们」自称；结尾只留落款不加寒暄。',
              onChange: set('instructions'),
              style: { minHeight: '110px' },
            }),
          ),
          h('div', { className: 'dsh-mail-section' }, '提示词预览（根据已保存的配置生成）'),
          h('div', { className: 'dsh-mail-pre' }, preview || '（暂无）'),
          status ? h('div', { className: status.tone, style: { marginTop: '10px' } }, status.text) : null,
          h('div', { className: 'dsh-mail-note' }, '提示：保存只写入当前 profile 的本地配置；换账号后建议清空旧缓存（~/.local/share/dsh-team-mail/state.json）。'),
          h(
            'div',
            { className: 'dsh-mail-modal-actions', style: { marginTop: '14px' } },
            h(Button, { ghost: true, onClick: onClose, disabled: busy }, '关闭'),
            h(Button, { onClick: () => save(true), disabled: busy }, busy ? '处理中…' : '保存并测试连接'),
            h(Button, { primary: true, onClick: () => save(false), disabled: busy }, busy ? '保存中…' : '保存'),
          ),
        ),
      );
    }

    function Handoff({ state, onChange, onCancel, onSubmit }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onCancel]);
      return h(
        'div',
        { className: 'dsh-mail-overlay', onClick: (event) => event.target === event.currentTarget && onCancel() },
        h(
          'div',
          { className: 'dsh-mail-modal', role: 'dialog', 'aria-label': '交给 Agent' },
          h('h3', null, '交给 Agent 处理'),
          h('span', { className: 'dsh-mail-sub' }, `${state.message.id} · ${state.message.subject || '(无主题)'}`),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', { htmlFor: 'dsh-mail-ws' }, '工作区'),
            h(
              'select',
              {
                id: 'dsh-mail-ws',
                value: state.workspaceId || '',
                onChange: (event) => onChange({ ...state, workspaceId: event.target.value }),
              },
              ...(state.items || []).map((item) =>
                h('option', { key: item.id, value: item.id }, `${item.title || item.path}（${item.path}）`),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', { htmlFor: 'dsh-mail-template' }, '处理方式'),
            h(
              'select',
              {
                id: 'dsh-mail-template',
                value: state.template,
                onChange: (event) => onChange({ ...state, template: event.target.value }),
              },
              ...TEMPLATES.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
          ),
          h(
            'div',
            { className: 'dsh-mail-field' },
            h('label', { htmlFor: 'dsh-mail-instruction' }, '补充说明（可选）'),
            h('textarea', {
              id: 'dsh-mail-instruction',
              value: state.instruction,
              placeholder: '例如：按邮件里的清单逐项确认，把结论回复给李子琰',
              onChange: (event) => onChange({ ...state, instruction: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'dsh-mail-remember' },
            h('input', {
              type: 'checkbox',
              checked: Boolean(state.remember),
              onChange: (event) => onChange({ ...state, remember: event.target.checked }),
            }),
            '记住这个工作区作为默认',
          ),
          h('div', { className: 'dsh-mail-note' }, '会在所选工作区新建（或复用空白）会话，把邮件正文作为任务上下文提交；不会自动发送任何邮件。'),
          h(
            'div',
            { className: 'dsh-mail-modal-actions' },
            h(Button, { ghost: true, onClick: onCancel, disabled: state.busy }, '取消'),
            h(Button, { primary: true, onClick: onSubmit, disabled: state.busy || !state.workspaceId }, state.busy ? '提交中…' : '开始处理'),
          ),
        ),
      );
    }

    function ConfirmDelete({ count, busy, onCancel, onConfirm }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [onCancel]);
      return h(
        'div',
        { className: 'dsh-mail-overlay', onClick: (event) => event.target === event.currentTarget && onCancel() },
        h(
          'div',
          { className: 'dsh-mail-modal', role: 'dialog', 'aria-label': '确认删除' },
          h('h3', null, '确认删除'),
          h('span', { className: 'dsh-mail-sub' }, `将把 ${count} 封邮件移动到「已删除」文件夹，此操作不可撤销。`),
          h(
            'div',
            { className: 'dsh-mail-modal-actions' },
            h(Button, { ghost: true, onClick: onCancel, disabled: busy }, '取消'),
            h(Button, { danger: true, onClick: onConfirm, disabled: busy }, busy ? '删除中…' : '确认删除'),
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        app = ctx;
        // Install the panel stylesheet once for the plugin lifetime, so the
        // sidebar icon is styled even while the mail panel is not mounted.
        for (const existing of document.querySelectorAll('style[data-dsh-mail]')) existing.remove();
        const sheet = document.createElement('style');
        sheet.setAttribute('data-dsh-mail', '');
        sheet.textContent = CSS;
        document.head.appendChild(sheet);
        ctx.effect(() => () => sheet.remove());
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'team-mail', order: 20, label: () => '邮件' }, MailIcon),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'team-mail', label: '邮件' }, MailPanel),
        );
      },
    };
  },
});
