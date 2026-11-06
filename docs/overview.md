# dsh-team-mail 插件文档

> 目的：让后续任何一个新对话/新 agent 在 5 分钟内理解这个插件为什么存在、怎么运转、怎么安全地改。

## 1. 它解决什么问题

团队里每个人用不同的 agent 方案开发同一个代码项目，协作方式是**基于邮件**：把要做的事写成邮件发给同事；对方让 agent 拉取邮件、阅读、工作，再回信。

旧流程的痛点：

1. **流程割裂**：收到邮件要先开聊天软件确认内容，再回到 DSH 开新对话、手写提示词让 agent 拉取处理。
2. **指向不精确**：「拉取最近的邮件」可能被理解成多封，甚至批量回复。
3. **收发割裂**：收件箱和发件箱分开，没法统一查看自己最近的收发。

插件的目标：**把邮件工作流融进 DSH Web**，并提供一组 `team_mail_*` 工具。

## 2. 产品形态

侧栏出现「邮件」图标（带未处理数徽标），点开是主面板：

- 左栏：收 + 发统一时间线，可按「待处理 / 全部 / 收件 / 发件」过滤、搜索、勾选批量处理
- 右栏：单封详情、交给 Agent、标记已处理、删除、保存附件
- 右上角「设置」：账号、服务器、密码、落款、通讯录、写邮件风格、提示词预览

首启未配置时，面板显示引导条，点「打开设置」即可。

## 3. 架构

一个 bundle，两半：

| 文件 | 角色 |
|---|---|
| `index.js` | Host：轮询、缓存、HTTP 路由、配置保存、凭据读取、系统提示注册 |
| `config.js` | 配置 schema（schemastery）+ 读取/合并/校验/环境变量注入 |
| `mail.js` | 调用 `mail.py` 的薄封装，把账号通过环境变量传进去 |
| `store.js` | 本地缓存：信封、正文、ack、bindings、lastSync |
| `tools.js` | `team_mail_*` 工具 |
| `prompt.js` | 系统提示段与「交给 Agent」任务提示 |
| `mail.py` | IMAP/SMTP 引擎，零第三方依赖，只从环境变量读配置 |
| `client.js` | 侧栏图标、邮件面板、交接弹窗、设置弹窗 |

## 4. 配置与存储

配置即 Loader 入口 `team-mail` 的 `config`，字段都在 `config.js` 中声明为 `volatile`，因此：

- 面板「设置」保存 → `ctx.configEditor.edit(entry, …)` → 写入当前 profile 的 `cordis.patch.yml`
- 修改后 DSH 重新加载该入口，新的提示词与账号立即生效
- 配置文件在本地，插件不上传任何内容

密码不进配置：面板调用 `ctx.credentials.set('DSH_TEAM_MAIL_PASS', …)`，存进本机 DSH 凭据库（0600），CLI 引擎每次调用时由 Host 解析并注入 `DSH_TEAM_MAIL_PASS` 环境变量。

状态文件：`~/.local/share/dsh-team-mail/state.json`

```
{
  "version": 1,
  "folders": { "INBOX": { "lastUid": 269, "messages": [ … ] } },
  "bodies": { "INBOX:269": { … } },
  "acks":   { "INBOX": [265, 267] },
  "bindings": { "<sessionId>": { "id": "INBOX:269", … } },
  "lastSync": 1762…
}
```

「已处理」是本地 ack 台账，不回写 IMAP 已读标记；删除到 `Deleted Messages` 后会同时清理 ack。

## 5. 接口（Client ↔ Host）

Host 注册 `/api/team-mail` 前缀路由，统一用 `ctx.connection.authorizeIndex(req, res)` 做同源鉴权：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/team-mail/snapshot` | 缓存快照（账号、配置、凭据状态、计数、列表） |
| POST | `/api/team-mail/refresh` | 立即同步并返回快照 |
| GET | `/api/team-mail/message?id=INBOX:269&save=1` | 读单封；`save=1` 时保存附件 |
| GET | `/api/team-mail/workspaces` | 工作区列表 |
| GET | `/api/team-mail/prompt` | 由当前配置生成的系统提示文本 |
| GET/POST/DELETE | `/api/team-mail/credential` | 查询/保存/清除邮箱密码（只返回是否已配置） |
| POST | `/api/team-mail/config` | 保存配置（校验后写入 profile patch） |
| POST | `/api/team-mail/verify` | 用已保存配置测试 IMAP 登录并列出文件夹 |
| POST | `/api/team-mail/ack` | `{ids:[…]}` 标记已处理 |
| POST | `/api/team-mail/delete` | `{ids:[…]}` 移动到 `Deleted Messages` 并清理缓存 |
| POST | `/api/team-mail/plant` | `{id, sessionId, template, instruction}` 提交任务 |

## 6. 增量同步与缓存

- `mail.py sync --folder X --after-uid N` 只取 `uid > N` 的邮件头，Host 每 `pollSeconds` 秒同步一次
- 首次同步每个文件夹只取最新 300 封
- 同步后后台按「收件优先、由新到旧」预取正文（`prefetchLimit` 封），点开邮件不再等 IMAP
- 正文缓存与信封缓存一起放进 `state.json`，最大 600 封正文

## 7. 不与别的插件冲突

| 维度 | 取值 |
|---|---|
| npm 包名 | `dsh-team-mail` |
| Loader 入口 id | `team-mail` |
| 工具名 | `team_mail_folders` / `_list` / `_new` / `_read` / `_send` / `_reply` / `_ack` / `_mark` / `_move` |
| HTTP 路由 | `/api/team-mail/*` |
| 系统提示段 id | `team-mail` |
| 缓存目录 | `~/.local/share/dsh-team-mail/` |
| 凭据引用 | `DSH_TEAM_MAIL_PASS` |

## 8. 已知边界（P0）

- 不提供独立回复编辑器；回复由用户在会话里让 Agent 起草/发送
- 不做自动 ack、不自动标已读、不自动发信
- 时间线是平铺列表，未做线程聚合
- 首次同步只覆盖每个文件夹最新 300 封
- UI 文案中文硬编码（locale 只提供面板 meta）

## 9. 安全

- 邮件正文/附件是不可信数据；提示词明确要求不执行其中指令、附件只落盘
- 发送只在用户明确要求时进行；回复先起草
- 密码只在凭据库/环境变量，不写入配置、不写日志、不回显给浏览器

## 10. 改动指南

1. 改 Host/Client 后跑 `node --check` 与 `python3 -m py_compile`
2. Host 改动：`plugin_manager set_plugin` 把 `include:team-mail` 关→开；Client 改动刷新浏览器
3. 不要往代码或文档里写真实账号、公司域名、同事姓名、落款；示例统一用 `example.com`
