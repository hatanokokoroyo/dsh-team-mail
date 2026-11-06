#!/usr/bin/env python3
"""邮箱 CLI（任意 IMAP+SMTP）：给 agent 用的读、搜、发、回复、附件工具。

零第三方依赖，只用 Python 标准库（imaplib / smtplib / email）。

配置与凭据全部来自环境变量，由 DSH 插件在每次调用时注入；本脚本不读写
任何配置文件，因此面板配置和 CLI 行为不会漂移：

    DSH_TEAM_MAIL_USER          邮箱地址
    DSH_TEAM_MAIL_PASS          邮箱密码 / 客户端授权码（来自本地凭据库）
    DSH_TEAM_MAIL_IMAP_HOST     IMAP 服务器
    DSH_TEAM_MAIL_IMAP_PORT     端口，默认 993
    DSH_TEAM_MAIL_IMAP_SSL      1/0，默认 1
    DSH_TEAM_MAIL_SMTP_HOST     SMTP 服务器
    DSH_TEAM_MAIL_SMTP_PORT     端口，默认 465
    DSH_TEAM_MAIL_SMTP_SSL      1/0，默认 1
    DSH_TEAM_MAIL_FROM_NAME     发件人显示名
    DSH_TEAM_MAIL_SIGNATURE     自动追加的落款
    DSH_TEAM_MAIL_ALLOWED       可信发件人/域名，逗号分隔

常用
    mail.py folders
    mail.py list --unseen --limit 10
    mail.py list --from someone@example.com --since 3d
    mail.py read --uid 123 --json
    mail.py read --uid 123 --save-attachments ~/Downloads/mail
    mail.py send --to a@b.com --subject "标题" --body "正文" --attach f.tar.gz
    mail.py reply --uid 123 --body "收到，我来处理"
    mail.py mark --uid 123 --seen
    mail.py sync --folder INBOX --after-uid 200   # 供插件增量轮询

设计约定
    * 所有读操作默认 BODY.PEEK，不会把邮件标成已读（除非显式 --mark-seen）。
    * 所有命令都可用 --json 输出机器可读结构；文本模式给人看。
    * 附件只落盘、绝不执行；文件名做安全清洗。
    * “已处理”（ack）是本地状态，由插件维护，不回写服务器。
"""
import argparse
import base64
import email
import email.policy
import html
import imaplib
import json
import os
import re
import smtplib
import ssl
import sys
import time
from datetime import datetime, timedelta
from email.header import Header
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from pathlib import Path

PREFIX = "DSH_TEAM_MAIL_"


# ---------------------------------------------------------------- 配置
def _env(name, default=""):
    return os.environ.get(PREFIX + name, default) or default


def _flag(name, default):
    return _env(name, "1" if default else "0").strip().lower() not in ("0", "false", "no", "off", "")


def load_config():
    """Read the account from the environment injected by the DSH plugin."""
    return {
        "user": _env("USER"),
        "display_name": _env("FROM_NAME"),
        "signature": _env("SIGNATURE"),
        "imap": {
            "host": _env("IMAP_HOST"),
            "port": int(_env("IMAP_PORT", "993")),
            "ssl": _flag("IMAP_SSL", True),
        },
        "smtp": {
            "host": _env("SMTP_HOST"),
            "port": int(_env("SMTP_PORT", "465")),
            "ssl": _flag("SMTP_SSL", True),
        },
        "default_folder": "INBOX",
        "allowed_senders": [x.strip() for x in _env("ALLOWED").split(",") if x.strip()],
    }


def password_of(cfg):
    password = _env("PASS")
    if password:
        return password
    sys.exit(
        "缺少邮箱密码：请在 dsh 的邮件面板「设置」里保存密码，"
        "或设置环境变量 DSH_TEAM_MAIL_PASS。"
    )


# ---------------------------------------------------------------- IMAP 基础
def imap_utf7_decode(s):
    """RFC 3501 modified UTF-7 → str（中文文件夹名如 &XfJT0ZAB-）。"""
    out, i = [], 0
    while i < len(s):
        if s[i] == "&":
            j = s.find("-", i)
            if j < 0:
                out.append("&")
                break
            chunk = s[i + 1:j]
            if not chunk:
                out.append("&")
            else:
                b = chunk.replace(",", "/")
                b += "=" * (-len(b) % 4)
                out.append(base64.b64decode(b).decode("utf-16-be", "replace"))
            i = j + 1
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def imap_utf7_encode(s):
    out, buf = [], ""

    def flush():
        nonlocal buf
        if buf:
            b = base64.b64encode(buf.encode("utf-16-be")).decode().rstrip("=")
            out.append("&" + b.replace("/", ",") + "-")
            buf = ""

    for ch in s:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf += ch
    flush()
    return "".join(out)


class Mail:
    def __init__(self, cfg):
        self.cfg = cfg
        self.user = cfg["user"]
        im = cfg["imap"]
        if im.get("ssl", True):
            self.conn = imaplib.IMAP4_SSL(im["host"], int(im["port"]),
                                          ssl_context=ssl.create_default_context())
        else:
            self.conn = imaplib.IMAP4(im["host"], int(im["port"]))
            self.conn.starttls(ssl_context=ssl.create_default_context())
        self.conn.login(self.user, password_of(cfg))

    # -- 文件夹
    def folders(self):
        typ, data = self.conn.list()
        if typ != "OK":
            sys.exit(f"LIST 失败: {data}")
        out = []
        for raw in data:
            line = raw.decode(errors="replace") if isinstance(raw, bytes) else raw
            m = re.match(r'\((?P<flags>[^)]*)\)\s+"(?P<delim>[^"]*)"\s+(?P<name>.+)$', line)
            if not m:
                continue
            name = m.group("name").strip()
            if name.startswith('"') and name.endswith('"'):
                name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            out.append({
                "raw": name,
                "name": imap_utf7_decode(name),
                "delimiter": m.group("delim"),
                "flags": [f for f in m.group("flags").split() if f],
            })
        return out

    def select(self, folder=None, readonly=True):
        folder = folder or self.cfg.get("default_folder") or "INBOX"
        typ, data = self.conn.select(self._folder_arg(folder), readonly=readonly)
        if typ != "OK":
            sys.exit(f"打开文件夹失败: {folder} -> {data[0].decode(errors='replace')}")
        return folder, int(data[0] or 0)

    def _folder_arg(self, folder):
        # 用户可能给中文名（已解码）或原始 modified UTF-7
        return '"' + imap_utf7_encode(folder).replace("\\", "\\\\").replace('"', '\\"') + '"'

    # -- 查询
    def search(self, folder=None, unseen=False, sender=None, subject=None,
               since=None, text=None, limit=None, scan=300):
        """列邮件并过滤。

        实测腾讯企业邮的 IMAP SEARCH 只认 ALL/UNSEEN，FROM/SUBJECT/SENTSINCE/TEXT
        都会被忽略（返回全部）——所以这里只服务端取 UID，条件全部在本地过滤。
        """
        self.select(folder)
        typ, data = self.conn.uid("SEARCH", None, "ALL")
        if typ != "OK":
            sys.exit(f"SEARCH 失败: {data}")
        uids = [u for u in (data[0] or b"").split()][-int(scan):]
        if not uids:
            return []
        rows = self._headers(uids)
        frm, subj = (sender or "").lower(), (subject or "").lower()
        keep = []
        for r in rows:
            if unseen and r["seen"]:
                continue
            if frm and frm not in (r["from"] or "").lower():
                continue
            if subj and subj not in (r["subject"] or "").lower():
                continue
            if since and not _date_ge(r, since):
                continue
            keep.append(r)
        keep.sort(key=lambda r: r["uid"] or 0, reverse=True)
        if text:
            needle = text.lower()
            hit = []
            for r in keep:
                if len(hit) >= (limit or 20):
                    break
                body = self.fetch(r["uid"], folder=folder).get("text") or ""
                if needle in body.lower():
                    hit.append(r)
            keep = hit
        if limit:
            keep = keep[: int(limit)]
        return keep

    def _headers(self, uids):
        fields = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)])"
        out = []
        # 分批，避免超长命令
        for i in range(0, len(uids), 200):
            chunk = b",".join(uids[i:i + 200]).decode()
            typ, data = self.conn.uid("FETCH", chunk, fields)
            if typ != "OK":
                sys.exit(f"FETCH 失败: {data}")
            for item in data:
                if not isinstance(item, tuple) or len(item) < 2:
                    continue
                meta, raw = item[0].decode(errors="replace"), item[1]
                uid = re.search(r"UID (\d+)", meta)
                flags = re.search(r"FLAGS \(([^)]*)\)", meta)
                size = re.search(r"RFC822.SIZE (\d+)", meta)
                internal = re.search(r'INTERNALDATE "([^"]+)"', meta)
                msg = email.message_from_bytes(raw, policy=email.policy.default)
                out.append({
                    "uid": int(uid.group(1)) if uid else None,
                    "from": _addr(msg.get("From")),
                    "to": _addr(msg.get("To")),
                    "subject": _hdr(msg.get("Subject")),
                    "date": _hdr(msg.get("Date")),
                    "messageId": _hdr(msg.get("Message-ID")),
                    "references": _hdr(msg.get("References")),
                    "inReplyTo": _hdr(msg.get("In-Reply-To")),
                    "size": int(size.group(1)) if size else None,
                    "internalDate": internal.group(1) if internal else None,
                    "flags": sorted(set((flags.group(1) if flags else "").split())),
                    "seen": "\\Seen" in (flags.group(1) if flags else ""),
                })
        return out

    # -- 读取单封
    def fetch(self, uid, folder=None, mark_seen=False):
        self.select(folder, readonly=not mark_seen)
        part = "BODY[]" if mark_seen else "BODY.PEEK[]"
        typ, data = self.conn.uid("FETCH", str(uid), f"(UID FLAGS {part})")
        if typ != "OK":
            sys.exit(f"FETCH 失败: {data}")
        raw = None
        flags = ""
        for item in data:
            if isinstance(item, tuple) and len(item) > 1:
                flags = item[0].decode(errors="replace")
                raw = item[1]
                break
        if raw is None:
            return None
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        text, html_body, atts = _walk(msg)
        return {
            "uid": int(uid),
            "from": _addr(msg.get("From")),
            "to": _addr(msg.get("To")),
            "cc": _addr(msg.get("Cc")),
            "replyTo": _addr(msg.get("Reply-To")),
            "subject": _hdr(msg.get("Subject")),
            "date": _hdr(msg.get("Date")),
            "messageId": _hdr(msg.get("Message-ID")),
            "references": _hdr(msg.get("References")),
            "inReplyTo": _hdr(msg.get("In-Reply-To")),
            "text": text,
            "html": html_body,
            "attachments": atts,
            "seen": "\\Seen" in flags,
            "_raw": msg,
        }

    # -- 写操作
    def store_flag(self, uid, flag, add=True, folder=None):
        self.select(folder, readonly=False)
        op = "+FLAGS" if add else "-FLAGS"
        typ, data = self.conn.uid("STORE", str(uid), op, f"({flag})")
        return typ == "OK"

    def move(self, uid, dest, folder=None):
        self.select(folder, readonly=False)
        typ, _ = self.conn.uid("COPY", str(uid), self._folder_arg(dest))
        if typ != "OK":
            return False
        self.conn.uid("STORE", str(uid), "+FLAGS", "(\\Deleted)")
        self.conn.expunge()
        return True

    # -- 发送
    def build_message(self, to, subject, body, cc=None, bcc=None, html=False,
                      attachments=(), in_reply_to=None, references=None, reply_to=None):
        msg = EmailMessage()
        msg["From"] = formataddr((_display_name(self.cfg), self.user))
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        if bcc:
            msg["Bcc"] = ", ".join(bcc)
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=self.user.split("@")[-1])
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
        if references:
            msg["References"] = references
        if reply_to:
            msg["Reply-To"] = reply_to
        sig = self.cfg.get("signature") or ""
        full = (body or "") + (("\n\n" + sig) if sig else "")
        if html:
            msg.set_content(_html_to_text(full))
            msg.add_alternative(full, subtype="html")
        else:
            msg.set_content(full)
        for path in attachments:
            p = Path(path)
            if not p.exists():
                sys.exit(f"附件不存在: {path}")
            data = p.read_bytes()
            maintype = "application"
            subtype = "octet-stream"
            guess = {".gz": ("application", "gzip"), ".zip": ("application", "zip"),
                     ".png": ("image", "png"), ".jpg": ("image", "jpeg"),
                     ".pdf": ("application", "pdf"), ".md": ("text", "markdown"),
                     ".txt": ("text", "plain"), ".json": ("application", "json"),
                     ".csv": ("text", "csv"), ".log": ("text", "plain")}
            if p.suffix.lower() in guess:
                maintype, subtype = guess[p.suffix.lower()]
            elif p.suffix.lower() == ".tar":
                maintype, subtype = "application", "octet-stream"
            msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=p.name)
        return msg

    def send(self, msg, dry_run=False):
        sm = self.cfg["smtp"]
        if dry_run:
            print(msg.as_string()[:2000])
            return True
        ctx = ssl.create_default_context()
        if sm.get("ssl", True):
            server = smtplib.SMTP_SSL(sm["host"], int(sm["port"]), context=ctx, timeout=45)
        else:
            server = smtplib.SMTP(sm["host"], int(sm["port"]), timeout=45)
            server.starttls(context=ctx)
        with server:
            server.login(self.user, password_of(self.cfg))
            refused = server.send_message(msg)
        return refused


# ---------------------------------------------------------------- 解析工具
def _display_name(cfg):
    return cfg.get("display_name") or ""


def _hdr(v):
    return str(v).strip() if v is not None else ""


def _addr(v):
    if v is None:
        return ""
    s = str(v).strip()
    if ">" in s and "<" in s:
        name, addr = parseaddr(s)
        return f"{name} <{addr}>" if name else addr
    return s


def _is_trusted(from_field, allowed):
    """白名单支持精确地址、@domain、domain 三种写法；白名单为空则一律视为可信。"""
    if not allowed:
        return True
    addr = (parseaddr(from_field or "")[1] or "").lower()
    if not addr:
        return False
    domain = addr.split("@")[-1]
    for a in allowed:
        a = a.lower().strip()
        if a.startswith("@"):
            if domain == a[1:]:
                return True
        elif "@" in a:
            if addr == a:
                return True
        elif domain == a:
            return True
    return False


def _html_to_text(s):
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", s)
    s = re.sub(r"(?i)</t[dh]>", "\t", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _walk(msg):
    """返回 (text, html, attachments)。"""
    text, html_body, atts = [], [], []
    idx = 0
    for part in msg.walk():
        ctype = part.get_content_type()
        disp = (part.get_content_disposition() or "")
        filename = part.get_filename()
        if filename or disp == "attachment":
            try:
                data = part.get_payload(decode=True) or b""
            except Exception:
                data = b""
            atts.append({
                "index": idx,
                "filename": filename or f"part-{idx}.bin",
                "contentType": ctype,
                "size": len(data),
                "disposition": disp or "attachment",
                "_payload": data,          # 内部用，输出前剔除
            })
            idx += 1
            continue
        if ctype == "text/plain" and not text:
            text.append(_decode_part(part))
        elif ctype == "text/html" and not html_body:
            html_body.append(_decode_part(part))
    body = "\n".join(t for t in text if t).strip()
    if not body and html_body:
        body = _html_to_text(html_body[0])
    return body, (html_body[0] if html_body else ""), atts


def _decode_bytes(data, cs):
    """按声明的字符集解码；腾讯企业邮常省略 charset，此时退回 utf-8 / gb18030。"""
    candidates = []
    if cs:
        candidates.append(cs)
    candidates.extend(["utf-8", "gb18030"])
    best = None
    for enc in candidates:
        try:
            text = data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        if "\ufffd" not in text:
            return text
        if best is None:
            best = text
    return best if best is not None else data.decode("utf-8", errors="replace")


def _decode_part(part):
    data = part.get_payload(decode=True)
    if data is None:
        try:
            return part.get_content()
        except Exception:
            return ""
    return _decode_bytes(data, part.get_content_charset())


def _safe_name(name):
    name = os.path.basename(name or "attachment")
    name = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", name).strip("._") or "attachment"
    return name[:120]


def public(d):
    if isinstance(d, dict):
        return {k: public(v) for k, v in d.items() if not k.startswith("_")}
    if isinstance(d, list):
        return [public(x) for x in d]
    return d


# ---------------------------------------------------------------- 时间过滤
def parse_since(s):
    """3d / 12h / 30m / 2026-11-01 → datetime（本地过滤用）。"""
    if not s:
        return None
    s = str(s).strip()
    m = re.fullmatch(r"(\d+)([dhm])", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        delta = {"d": timedelta(days=n), "h": timedelta(hours=n), "m": timedelta(minutes=n)}[unit]
        return datetime.now() - delta
    return datetime.fromisoformat(s)


def _date_ge(row, since_dt):
    """用 Date 头（缺失时退回 INTERNALDATE）与 since 比较。"""
    from email.utils import parsedate_to_datetime
    dt = None
    try:
        dt = parsedate_to_datetime(row.get("date") or "")
    except Exception:
        dt = None
    if dt is None and row.get("internalDate"):
        try:
            dt = datetime.strptime(row["internalDate"], "%d-%b-%Y %H:%M:%S %z")
        except Exception:
            dt = None
    if dt is None:
        return True
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt >= since_dt


# ---------------------------------------------------------------- 子命令
def cmd_folders(args):
    cfg = load_config()
    m = Mail(cfg)
    fs = m.folders()
    if args.json:
        print(json.dumps(fs, ensure_ascii=False, indent=2))
        return
    for f in fs:
        print(f"{f['name']:<28} raw={f['raw']:<32} {','.join(f['flags'])}")


def cmd_list(args):
    cfg = load_config()
    m = Mail(cfg)
    rows = m.search(folder=args.folder, unseen=args.unseen, sender=args.sender,
                    subject=args.subject, since=parse_since(args.since),
                    text=args.text, limit=args.limit, scan=getattr(args, "scan", 300))
    allowed = cfg.get("allowed_senders") or []
    for r in rows:
        r["trusted"] = _is_trusted(r["from"], allowed)
    rows.sort(key=lambda r: r["uid"] or 0, reverse=True)
    if getattr(args, "uids_only", False):
        print("\n".join(str(r["uid"]) for r in rows))
        return
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    for r in rows:
        flag = " " if r["seen"] else "*"
        mark = "" if r.get("trusted", True) else " [非白名单]"
        print(f"{flag} {r['uid']:>6}  {r['date'][:25]:<25} {r['from'][:34]:<34} {r['subject'][:50]}{mark}")


def cmd_read(args):
    cfg = load_config()
    m = Mail(cfg)
    msg = m.fetch(args.uid, folder=args.folder, mark_seen=args.mark_seen)
    if not msg:
        sys.exit(f"找不到 uid={args.uid}")
    saved = []
    if args.save_attachments:
        d = Path(os.path.expanduser(args.save_attachments))
        d.mkdir(parents=True, exist_ok=True)
        for a in msg["attachments"]:
            p = d / _safe_name(a["filename"])
            n = 1
            while p.exists():
                p = d / f"{p.stem}-{n}{p.suffix}"
                n += 1
            p.write_bytes(a["_payload"])
            saved.append(str(p))
    out = public(msg)
    out["hasHtml"] = bool(msg["html"])
    if not args.html:
        out.pop("html", None)
    out["savedAttachments"] = saved
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    print(f"From: {msg['from']}\nTo: {msg['to']}\nDate: {msg['date']}\n"
          f"Subject: {msg['subject']}\nMessage-ID: {msg['messageId']}\n")
    print(msg["text"][: args.max_chars])
    if msg["attachments"]:
        print("\n附件:")
        for a, p in zip(msg["attachments"], saved):
            print(f"  - {a['filename']} ({a['size']} B, {a['contentType']})" + (f" -> {p}" if p else ""))


def _parse_addrs(v):
    out = []
    for x in v or []:
        out += [a.strip() for a in str(x).split(",") if a.strip()]
    return out


def cmd_send(args):
    cfg = load_config()
    m = Mail(cfg)
    body = args.body or ""
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    if body == "-":
        body = sys.stdin.read()
    msg = m.build_message(_parse_addrs(args.to), args.subject, body,
                          cc=_parse_addrs(args.cc), bcc=_parse_addrs(args.bcc),
                          html=args.html, attachments=args.attach or [])
    res = m.send(msg, dry_run=args.dry_run)
    if args.dry_run:
        print("[dry-run] 未发送")
        return
    print(json.dumps({"to": _parse_addrs(args.to), "subject": args.subject,
                      "attachments": [os.path.basename(a) for a in (args.attach or [])],
                      "refused": res or {}}, ensure_ascii=False))


def cmd_reply(args):
    cfg = load_config()
    m = Mail(cfg)
    orig = m.fetch(args.uid, folder=args.folder)
    if not orig:
        sys.exit(f"找不到 uid={args.uid}")
    subj = orig["subject"] or ""
    if not re.match(r"(?i)^(re|回复)\s*[:：]", subj):
        subj = "Re: " + subj
    refs = " ".join(x for x in [orig["references"], orig["messageId"]] if x)
    body = args.body or ""
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    if body == "-":
        body = sys.stdin.read()
    if not body:
        body = ""
    if args.quote:
        quoted = "\n".join("> " + line for line in (orig["text"] or "").splitlines()[:80])
        body = body + "\n\n" + quoted
    to = [_addr(orig["replyTo"] or orig["from"])]
    cc = []
    if args.all and orig["cc"]:
        cc = [c.strip() for c in str(orig["cc"]).split(",") if c.strip()]
    msg = m.build_message(to, subj, body, cc=cc, attachments=args.attach or [],
                          in_reply_to=orig["messageId"], references=refs)
    if args.dry_run:
        print(msg.as_string()[:2000])
        print("[dry-run] 未发送")
        return
    res = m.send(msg)
    print(json.dumps({"replyTo": to, "subject": subj, "inReplyTo": orig["messageId"],
                      "cc": cc, "refused": res or {}}, ensure_ascii=False))


def cmd_mark(args):
    cfg = load_config()
    m = Mail(cfg)
    ok = True
    for uid in args.uid:
        ok = m.store_flag(uid, "\\Seen", add=args.seen, folder=args.folder) and ok
    print(json.dumps({"ok": ok, "uids": args.uid, "seen": args.seen}))


def cmd_move(args):
    cfg = load_config()
    m = Mail(cfg)
    ok = all(m.move(uid, args.to, folder=args.folder) for uid in args.uid)
    print(json.dumps({"ok": ok, "uids": args.uid, "to": args.to}))


def cmd_sync(args):
    """增量同步：只取 uid > after_uid 的邮件头，供 dsh 插件轮询。

    与 list 不同，这里先用 SEARCH ALL 拿 UID 列表（只返回编号，很便宜），
    再只对新增 UID 取头，避免每次轮询都扫最近数百封邮件。
    after_uid=0 表示首次同步，只取最新 limit 封（更老的邮件留在服务端，
    面板只覆盖近期）；增量同步取最老的 limit 封，避免中间漏邮件。
    """
    cfg = load_config()
    m = Mail(cfg)
    folder = args.folder or cfg.get("default_folder") or "INBOX"
    m.select(folder, readonly=True)
    typ, data = m.conn.uid("SEARCH", None, "ALL")
    if typ != "OK":
        sys.exit(f"SEARCH 失败: {data}")
    uids = sorted(int(u) for u in (data[0] or b"").split())
    after = int(args.after_uid or 0)
    fresh = [u for u in uids if u > after]
    limit = int(args.limit or 0)
    truncated = False
    if limit and len(fresh) > limit:
        truncated = True
        fresh = fresh[-limit:] if after == 0 else fresh[:limit]
    rows = m._headers([str(u).encode() for u in fresh]) if fresh else []
    allowed = cfg.get("allowed_senders") or []
    for r in rows:
        r["trusted"] = _is_trusted(r["from"], allowed)
    rows.sort(key=lambda r: r["uid"] or 0)
    out = {
        "folder": folder,
        "afterUid": after,
        "lastUid": max(r["uid"] for r in rows) if rows else after,
        "mailboxLastUid": uids[-1] if uids else 0,
        "truncated": truncated,
        "messages": rows,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description="邮箱 CLI（IMAP/SMTP）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("folders", help="列出文件夹")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_folders)

    p = sub.add_parser("list", help="列邮件（信封）")
    p.add_argument("--folder")
    p.add_argument("--unseen", action="store_true")
    p.add_argument("--from", dest="sender")
    p.add_argument("--subject")
    p.add_argument("--text", help="全文关键字")
    p.add_argument("--since", help="3d / 24h / 2026-11-01")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--scan", type=int, default=300, help="最多扫描最近多少封（本地过滤）")
    p.add_argument("--uids-only", action="store_true", help="只输出 uid，便于管道")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("read", help="读一封（正文+附件）")
    p.add_argument("--uid", type=int, required=True)
    p.add_argument("--folder")
    p.add_argument("--json", action="store_true")
    p.add_argument("--mark-seen", action="store_true")
    p.add_argument("--save-attachments", help="附件保存目录")
    p.add_argument("--html", action="store_true", help="json 中带上完整 HTML 正文（默认不带）")
    p.add_argument("--max-chars", type=int, default=4000)
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("send", help="发邮件")
    p.add_argument("--to", nargs="+", required=True)
    p.add_argument("--cc", nargs="*")
    p.add_argument("--bcc", nargs="*")
    p.add_argument("--subject", required=True)
    p.add_argument("--body")
    p.add_argument("--body-file")
    p.add_argument("--html", action="store_true")
    p.add_argument("--attach", nargs="*")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_send)

    p = sub.add_parser("reply", help="回复某封")
    p.add_argument("--uid", type=int, required=True)
    p.add_argument("--folder")
    p.add_argument("--body")
    p.add_argument("--body-file")
    p.add_argument("--attach", nargs="*")
    p.add_argument("--all", action="store_true", help="回复全部（带原 CC）")
    p.add_argument("--quote", action="store_true", help="附上原文引用")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_reply)

    p = sub.add_parser("mark", help="标记已读/未读")
    p.add_argument("--uid", type=int, nargs="+", required=True)
    p.add_argument("--folder")
    p.add_argument("--seen", dest="seen", action="store_true", default=True)
    p.add_argument("--unseen", dest="seen", action="store_false")
    p.set_defaults(func=cmd_mark)

    p = sub.add_parser("move", help="移动到其它文件夹")
    p.add_argument("--uid", type=int, nargs="+", required=True)
    p.add_argument("--to", required=True)
    p.add_argument("--folder")
    p.set_defaults(func=cmd_move)

    p = sub.add_parser("sync", help="增量同步邮件头（按 uid 递增，供面板轮询）")
    p.add_argument("--folder")
    p.add_argument("--after-uid", type=int, default=0)
    p.add_argument("--limit", type=int, default=300)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_sync)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
