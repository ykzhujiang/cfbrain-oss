# 数据存在哪、同步到哪

一句话结论：**默认什么都不同步。数据只在他自己电脑上，不会流向任何地方 —— 包括不会流向我们。**

要不要同步、同步到哪，完全由他自己决定。

---

## 1. 装完之后，数据在哪

`cfbrain init` 只在**本机**建一个目录：

```
~/.cfbrain/
├── pages/            ← 词条，纯 markdown。这是唯一真源
├── raw/              ← 原始素材（PDF、音频、截图…）
├── brain.pglite/     ← 数据库（约 39 MB 起）。可从 pages/ 完全重建
├── config.json       ← 配置。⚠️ 可能含 API key
├── CHANGELOG.md      ← 变更日志，自动维护
└── .git/             ← init 时自动 git init
```

没有服务器，没有云账号，没有注册。PGLite 是嵌入式 Postgres，跑在本地进程里。

---

## 2. 会不会自动传到别的地方

**不会。** 这一点实测确认过：

```bash
$ cd ~/.cfbrain && git remote -v
（空）
```

`init` 建了 git 仓库，**但没有配置任何远端**。没有远端就没有 `push` 目标，所以：

- ❌ 不会传到 GitHub
- ❌ 不会传到 CFBrain 项目仓库（`cfbrain-oss` 只是**代码**，跟他的数据毫无关系）
- ❌ 不会传给作者或任何第三方
- ❌ 没有遥测、没有埋点

**唯一的例外是他主动开的功能：**

| 功能 | 数据去哪 | 默认 |
|---|---|---|
| 语义搜索 `query` | 词条文本发给 OpenAI（或他配的兼容网关）做 embedding | **关闭**，要自己配 key |
| 飞书同步 `feishu push` | 词条发到**他自己**的飞书知识库 | **关闭**，要自己接 |
| 邮件摘要 `mail` | 发给**他自己**填的收件人 | **关闭**，默认收件人为空 |
| MCP `serve` | 只在本机进程间通信 | 要自己启动 |

不开这些，CFBrain 是完全离线的。

---

## 3. 自动 git commit（这个是开着的）

每次 `put` 会在 `~/.cfbrain` **本地自动 commit**：

```
$ git log --oneline --stat
02a1382 put: sync-test — Page created via put_page
 CHANGELOG.md                |  4 ++++
 pages/sync-test.md          |  8 ++++++++
 raw/2026-09-08-sync-test.md |  6 ++++++
```

**只是本地 commit，不 push。** 好处是每次改动都有版本记录，写错了能回退（`cfbrain history <slug>` / `revert`）。

### 哪些进 git、哪些不进

| | 进 git | 为什么 |
|---|---|---|
| `pages/` | ✅ | 这就是知识本体，版本化才有意义 |
| `raw/` | ✅ | 原始素材要跟词条一起留存 |
| `CHANGELOG.md` | ✅ | 变更记录 |
| `config.json` | ❌ **已忽略** | **可能含明文 API key** |
| `brain.pglite/` | ❌ **已忽略** | 39 MB、上千个文件，且可从 pages/ 重建 |

> ⚠️ **这两条忽略规则是本版本刚修的。** 之前默认的 `.gitignore` 只挡 `*.db` 和 `PGDATA/`，
> 没挡 `config.json` 和 `brain.pglite/` —— 意味着用户一旦 `git push`，就会把自己的
> API key 和 39 MB 数据库推上去。而**`.gitignore` 对已提交的文件无效**，key 一旦进了
> 历史就得轮换。
>
> 这个坑我们在自己的生产库上真踩过（见 [AUDIT-AND-STRIPPING.md](AUDIT-AND-STRIPPING.md)：
> 4 个密钥进了 git 历史、仓库被数据库副本撑到 1.9 GB）。所以这次把安全默认值写进了
> 工具本身，而不是写进文档指望人记得。

他自己往 `.gitignore` 加规则会保留，不会被自动 commit 覆盖（实测确认）。

---

## 4. 他想同步的话，怎么做

CFBrain 不替他决定，他自己建一个仓库接上就行。

### 方式 A：同步到他自己的 GitHub 私有仓库（推荐）

```bash
# 1. 在 GitHub 建一个空仓库，必须选 Private
# 2. 接上
cd ~/.cfbrain
git remote add origin git@github.com:他的账号/my-brain.git
git push -u origin main
```

之后每次 `put` 会自动本地 commit，他定期 `git push` 即可。

想自动推送就加个 cron：

```bash
cd ~/.cfbrain && git push origin main
```

> ⚠️ **仓库必须是 Private。** `pages/` 里是他的真实知识 —— 人物、公司、判断。
> 推之前建议先确认 `git status` 里没有 `config.json`：
> ```bash
> cd ~/.cfbrain && git check-ignore config.json && echo "安全"
> ```

### 方式 B：换到远程 Postgres（多设备实时共享）

本地 PGLite 适合单机。要多台设备共用同一个大脑：

```bash
cfbrain migrate --to supabase
```

数据库进他自己的 Supabase/Postgres 实例。见 [ENGINES.md](ENGINES.md)。

### 方式 C：不用 git，用网盘/时间机器

`~/.cfbrain` 就是普通目录，丢进 iCloud / Dropbox / 坚果云也行。

但注意：**别让网盘同步 `brain.pglite/`**，数据库文件被并发写会损坏。只同步 `pages/` 和 `raw/` 更安全，需要时用 `cfbrain import` 重建数据库。

### 方式 D：什么都不做

完全可以。数据就在本机，`cfbrain export` 随时能导出全部 markdown。不存在被锁死的问题。

---

## 5. 他和我们的仓库是什么关系

| | 内容 | 归谁 |
|---|---|---|
| `github.com/ykzhujiang/cfbrain-oss` | **只有代码**（CLI 源码、文档、模板） | 我们，MIT 协议 |
| 他的 `~/.cfbrain/` | **只有他的数据** | 他自己，完全私有 |
| 他自己建的 `my-brain` 私有仓库 | 他的数据备份（可选） | 他自己 |

**这三者之间没有任何数据通道。** 他从我们的仓库拿的是一个工具，工具产生的数据从头到尾在他手里。

我们也拿不到他的数据 —— 没有服务端，没有账号体系，没有回传。

---

## 6. 一句话回答常见疑问

| 问题 | 答案 |
|---|---|
| 装完数据传到哪？ | 只在 `~/.cfbrain`，不传任何地方 |
| 要注册账号吗？ | 不要，没有账号体系 |
| 要联网吗？ | 核心功能不要。只有语义搜索/飞书/邮件才联网 |
| 你们能看到我的笔记吗？ | 不能，没有服务端 |
| 数据会被锁在工具里吗？ | 不会，`pages/` 就是普通 markdown，`export` 随时导出 |
| 换电脑怎么办？ | 拷 `~/.cfbrain` 过去，或走上面的 git 方案 |
| 数据库删了会丢知识吗？ | 不会，`cfbrain import ~/.cfbrain/pages` 可重建 |
| 我的 API key 会泄漏吗？ | `config.json` 已默认 gitignore。但仍**不要**把 brain 仓库设成 public |
