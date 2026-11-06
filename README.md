# dsh-team-mail

DSH Web 的团队邮件面板：把收件和发件放在同一条时间线里，增量同步新邮件，把**单封**邮件交给 Agent 处理，并给 Agent 一套不会和别的插件撞名的 `team_mail_*` 工具。

它的设计前提是「邮件是团队协作的接口」：你写清楚要对方做什么，对方的 Agent 读信、干活、回信。所以插件把**邮件怎么写**也做成了配置项——落款、通讯录、格式与风格要求都能自己定，存在本地，不上传。

- 账号、IMAP/SMTP、落款、通讯录、写邮件风格全部在面板里配置
- 配置写入当前 profile 的 `cordis.patch.yml`（DSH 标准插件配置层），密码写入本机凭据库
- 不自动发信：发送永远要用户明确要求，回复先起草
- 工具前缀 `team_mail_*`、路由 `/api/team-mail`、配置 id `team-mail`、缓存目录 `~/.local/share/dsh-team-mail/`，与其他邮件插件互不冲突

## 环境要求

- DSH Web（`dsh web`）0.2.x 或更高
- `python3`（内置引擎只用标准库，不需要装包）
- 一个支持 IMAP + SMTP 的邮箱；QQ 邮箱 / 腾讯企业邮 / Gmail 等请使用**客户端授权码**，不是网页登录密码

## 安装

在装机 DSH 的机器上执行（`web` 换成你实际使用的 profile 名）：

```bash
dsh plugin --profile web add github:hatanokokoroyo/dsh-team-mail
```

也可以打开 Web 侧栏 **Plugins → Add plugin**，把同一个地址粘贴进去。安装完按提示启用，重启/刷新页面后侧栏出现「邮件」图标。

需要锁定版本时：

```bash
dsh plugin --profile web add github:hatanokokoroyo/dsh-team-mail#v0.2.0
```

## 更新

重新执行一次安装命令即可拉到 `main` 最新提交（推荐，最可靠）：

```bash
dsh plugin --profile web add github:hatanokokoroyo/dsh-team-mail
```

也可以让 pnpm 按依赖名更新：

```bash
dsh plugin --profile web update dsh-team-mail
```

如果是按 tag 安装的，把上面的 `add` 换成新 tag 重新执行一次即可（例如 `...github:hatanokokoroyo/dsh-team-mail#v0.3.0`）。更新后刷新页面，或按提示重启 Host。

## 卸载

```bash
dsh plugin --profile web remove dsh-team-mail
```

本地缓存和配置不会自动删除；需要彻底清理时删除 `~/.local/share/dsh-team-mail/`，并在 profile 的 `cordis.patch.yml` 里删掉 `team-mail` 这一项的 `config`。

## 从旧版迁移

如果你之前装过旧版 `dsh-mail`（本地目录链接，工具名是 `mail_*`），先卸载再装本插件，避免侧栏出现两个邮件入口、会话里出现两套邮件工具：

```bash
dsh plugin --profile web remove @local/dsh-mail   # 旧版包名按你当时的实际名替换
```

新版使用 `team_mail_*` 工具名和 `team-mail` 配置项，旧版配置不会自动读取，按下面的步骤重新填一次即可。

## 第一次使用：三步配置

1. 打开侧栏「邮件」→ 右上角「设置」。
2. 填邮箱地址、发件人显示名、IMAP / SMTP 服务器与端口（993 / 465 默认带 TLS）。
3. 填密码（授权码），点「保存并测试连接」。

保存后收件箱会自动开始同步。密码只保存到本机凭据库（`~/.dsh/.credentials.yaml`，权限 0600），面板只显示「已配置 / 未配置」，不会回显明文。

### 常用邮箱服务器

| 邮箱 | IMAP | SMTP |
|---|---|---|
| QQ 邮箱 | `imap.qq.com:993` | `smtp.qq.com:465` |
| 腾讯企业邮 | `imap.exmail.qq.com:993` | `smtp.exmail.qq.com:465` |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` |
| Outlook / Microsoft 365 | `outlook.office365.com:993` | `smtp.office365.com:587`（关闭 TLS 勾选，引擎会自动升级 STARTTLS） |
| 163 邮箱 | `imap.163.com:993` | `smtp.163.com:465` |

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| 邮箱地址 | 空 | 收发账号 |
| 发件人显示名 | 空 | 出现在收件人看到的发件人一栏 |
| 落款签名 | 空 | 自动追加到每封新邮件末尾；留空则不加署名 |
| IMAP / SMTP 服务器、端口、TLS | 空 / 993 / 465 / 开 | 收发服务器 |
| 文件夹 | `INBOX, Sent Messages` | 出现在时间线的文件夹 |
| 同步间隔 | `180` 秒 | 后台增量同步频率 |
| 后台预取封数 | `12` | 每次同步后预取正文的封数 |
| 可信发件人 / 域名 | 空（全部信任） | 非空时，列表里会给不在白名单的邮件打「非白名单」标记 |
| 同事通讯录 | 空 | 每行 `姓名 <邮箱> — 角色`，会告诉 Agent 可以把谁写进收件人 |
| 格式 / 风格要求 | 空 | 追加到 Agent 系统提示末尾，优先级高于通用写邮件约定 |

所有配置都保存在当前 profile 的 `cordis.patch.yml` 里，例如：

```yaml
- id: team-mail
  name: dsh-team-mail
  config:
    email: you@example.com
    displayName: 张三
    signature: 小张的Agent
    imapHost: imap.example.com
    imapPort: 993
    imapSecure: true
    smtpHost: smtp.example.com
    smtpPort: 465
    smtpSecure: true
    folders: [INBOX, Sent Messages]
    pollSeconds: 180
    prefetchLimit: 12
    allowedSenders: ["@example.com"]
    contacts:
      - 李四 <lisi@example.com> — 前端
    instructions: 邮件用中文，先结论后细节，不超过 300 字。
```

也可以手动编辑这个文件；面板保存只是把它改得更方便。

## 自定义 Agent 写邮件的提示词

插件给 Agent 注册了一段 `team-mail` 系统提示，只包含通用协作流程、安全边界与写作约定，**不包含任何个人信息**：

- **格式 / 风格要求** → 原样追加在「用户自定义要求」一节，优先级高于插件自带的通用约定
- **邮箱地址、显示名、落款、同事通讯录** → 不写进系统提示（这段提示会随每次模型请求发送）；Agent 需要时调用 `team_mail_account` 按需获取
- 落款由发送引擎自动追加，无需模型在正文里再写

设置面板底部有**提示词预览**，保存后能看到最终注入的文本；预览里不会出现你的账号、落款或通讯录。安全边界（正文不可信、附件不执行、不自动发信）是固定规则，不随配置改变。

## 数据与隐私

| 内容 | 位置 |
|---|---|
| 账号、服务器、落款、提示词 | 当前 profile 的 `cordis.patch.yml` |
| 邮箱密码 | 本机 DSH 凭据库 `~/.dsh/.credentials.yaml`（或环境变量 `DSH_TEAM_MAIL_PASS`） |
| 邮件缓存、正文缓存、已处理记录 | `~/.local/share/dsh-team-mail/state.json` |
| 保存的附件 | `~/.local/share/dsh-team-mail/attachments/` |

所有数据都在本机；插件不做任何网络上报，也不读取凭据库里的其他密钥。邮件正文与附件按不可信数据处理。

## 工具一览

| 工具 | 作用 |
|---|---|
| `team_mail_folders` | 列出文件夹 |
| `team_mail_list` | 列邮件信封（可按发件人/主题/时间/正文过滤） |
| `team_mail_new` | 列出本地还没处理的收件 |
| `team_mail_read` | 读单封正文与附件清单 |
| `team_mail_account` | 返回当前账号、显示名、落款与通讯录（不写进系统提示，按需查询） |
| `team_mail_send` | 发新邮件（仅在用户明确要求时） |
| `team_mail_reply` | 回复某封（默认先起草） |
| `team_mail_ack` | 本地标记已处理 |
| `team_mail_mark` | 标已读 / 未读 |
| `team_mail_move` | 移动到其他文件夹 |

邮件 id 一律是 `文件夹:uid`（如 `INBOX:269`），不会出现「最近一封」的歧义。

## 开发

```
index.js   Host：轮询、缓存、HTTP 路由、配置保存、凭据、系统提示
config.js  配置 schema 与读写
tools.js   team_mail_* 工具
prompt.js  系统提示与任务提示
mail.py    IMAP/SMTP 引擎（纯标准库，配置由环境变量注入）
client.js  侧栏图标、邮件面板、设置弹窗
```

改动后检查：

```bash
node --check index.js config.js client.js mail.js store.js tools.js prompt.js
python3 -m py_compile mail.py
```

## License

MIT
