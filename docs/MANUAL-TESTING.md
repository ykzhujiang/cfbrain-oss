# 手动测试指南

给人用的测试步骤。每步都写清楚**预期看到什么**，以及**看到什么就是坏了**。

两条路径可以测：

- **A. 单文件二进制** —— 下载一个文件就能跑，不需要装任何东西。这是给同学的主推方式。
- **B. 源码安装** —— 需要 Bun，适合要改代码的人。

---

## A. 测单文件二进制（推荐先测这个）

### A0. 先拿到二进制

仓库里没有预编译文件（二进制 79 MB，不适合进 git）。自己编一个：

```bash
cd cfbrain-clean
bun run build            # 产出 bin/cfbrain，约 10 秒
```

想编 Linux 版一起：

```bash
bun run build:all        # bin/cfbrain-darwin-arm64 (79M) + bin/cfbrain-linux-x64 (116M)
```

### A1. 一键自动验证（最省事）

```bash
./scripts/verify-binary.sh
```

这个脚本会把二进制拷到一个空目录、清空 `PATH`、给一个全新的假 HOME，然后跑 11 项检查。

**预期最后一行：**

```
  11 passed, 0 failed
The binary is self-contained.
```

**只要有一个 FAIL，就是坏了**，脚本会打印具体哪一步和错误内容。

### A2. 手动逐步测（想亲眼看的话）

刻意模拟「同学的电脑」——没有 Bun、没有源码：

```bash
# 1. 建一个干净目录，只放二进制
mkdir -p /tmp/mytest && cp bin/cfbrain /tmp/mytest/
cd /tmp/mytest && ls          # 预期：只有 cfbrain 一个文件

# 2. 用一个全新的 HOME，并清空环境变量（env -i 表示不继承任何变量，包括 PATH）
export H=/tmp/myhome && mkdir -p $H
alias cf='env -i PATH=/usr/bin:/bin HOME=$H /tmp/mytest/cfbrain'

# 3. 看它跑不跑
cf --help
```
预期：打印 `cfbrain 0.8.0 -- personal knowledge brain` 和命令列表。

```bash
# 4. 建知识库 —— 这一步最关键
cf init --pglite --non-interactive
```
**预期最后几行：**
```
Brain ready at /tmp/myhome/.cfbrain/brain.pglite
0 pages. Engine: PGLite (local Postgres).
Types: person, company, meeting, project, decision, concept, intel, deal, note, recruit
```
**坏了会看到**（这是我这轮修的两个 bug，如果又出现说明回退了）：
```
ENOENT: open '/$bunfs/root/pglite.data'          <- WASM 没嵌进去
error: Extension bundle not found: ...tar.gz     <- 扩展没嵌进去
```

```bash
# 5. 写一条、读回来
cat > $H/p.md <<'EOF'
---
title: 我的第一条
types: [note]
---

手动测试写入。
EOF
cf put my-first --content-file $H/p.md --no-embed
cf get my-first
cf list
```
预期：`put` 返回 `"status": "created_or_updated"`；`get` 打印出内容；`list` 里有 `my-first`。

```bash
# 6. 搜索（验证数据库索引正常）
cf search "手动" --no-embed     # 中文可能搜不到，见下方说明
cf search "note" --no-embed
```

```bash
# 7. 体检
cf doctor --json
```
预期：开头是 `{"status":"healthy"`。

> `pgvector` 和 `rls` 显示 `warn` 是**正常的**，本地 PGLite 模式查不到这两项，不是故障。

```bash
# 8. 收尾清理
rm -rf /tmp/mytest /tmp/myhome
unalias cf
```

### A3. 测「自定义分类」（你关心的能力）

```bash
cf types list                          # 看当前分类
cf types add paper --label "论文"       # 加自己的
cf types remove deal                   # 删不要的
cf types list                          # 确认变了
```

再验证真的生效：

```bash
printf -- '---\ntitle: 一篇论文\ntypes: [paper]\n---\n\nok\n' > $H/a.md
cf put my-paper --content-file $H/a.md --no-embed      # 预期：成功

printf -- '---\ntitle: 测试\ntypes: [deal]\n---\n\nok\n' > $H/b.md
cf put should-fail --content-file $H/b.md --no-embed   # 预期：被拒绝
```
第二条**预期报错**（这就是对的）：
```
Error [invalid_params]: Invalid type(s): deal. Allowed types: ..., paper. Use --force to bypass.
```

### A4. 测「其他 Agent 能录入」（MCP）

最简单的验证方式，不用配任何 Agent：

```bash
cf call get_page '{"slug":"my-first"}'
cf call put_page '{"slug":"from-tool","content":"---\ntitle: T\ntypes: [note]\n---\nbody"}'
```
预期：都返回 JSON。这说明工具层通了。

要验证完整 MCP 协议，用 `./scripts/verify-binary.sh`，它第 8 步会真的模拟一个外部 Agent 连上来写入。

真接到 Claude / OpenCode 上：

```json
{
  "mcpServers": {
    "cfbrain": {
      "command": "/absolute/path/to/cfbrain",
      "args": ["serve"]
    }
  }
}
```
配好后在对话里让它 `list pages`，能列出来就是通了。

### A5. 测「我的数据会不会被推出去」（重要）

这是最该亲眼确认的一项。

```bash
# 用 --key 故意塞一个假 key 进去
cf init --pglite --non-interactive --key sk-faketestkey1234567890
cd $H/.cfbrain

# 1. 有没有配远端？应该是空的
git remote -v
```
**预期：完全没有输出**（没有远端 = 不可能推到任何地方）。

```bash
# 2. 假 key 会被提交吗？
git check-ignore config.json && echo "已忽略（安全）" || echo "会被提交（危险）"

# 3. 数据库会被提交吗？
git check-ignore brain.pglite && echo "已忽略" || echo "会被提交"

# 4. 一共几个文件待提交？
git add -A --dry-run | wc -l
```
**预期：** 前两个都是「已忽略」，第 4 项是 `1`（只有 `.gitignore`）。

```bash
# 5. 写一条词条，看自动 commit 收了什么
cf put t1 --content-file $H/p.md --no-embed
cd $H/.cfbrain && git log --oneline --stat -1
```
**预期：** commit 里只有 `pages/`、`raw/`、`CHANGELOG.md`、`.gitignore`。
**如果出现 `config.json` 或 `brain.pglite/...`，那是 ❌ 严重问题。**

> 这一项在验证：用户不会因为使用默认配置就泄漏自己的 API key。

### A6. 测飞书前置检测（不装也能测）

```bash
cf feishu setup --check
```

**如果本机没装 lark-cli，预期：**
```
1. lark-cli
  --    lark-cli is not installed
  Install it with:  npm install -g @larksuite/cli
```

**如果已装且已授权，预期三项全绿：**
```
1. lark-cli        ok  lark-cli is installed
2. Feishu app      ok  configured (app cli_xxxx)
3. Authorisation   ok  logged in as <你的名字>
```

`--check` 只检查、不改任何东西，可以放心跑。

真要装的话去掉 `--check`，它会**先问你**才装：

```bash
cf feishu setup
# -> Install @larksuite/cli globally via npm now? [Y/n]
```

---

## B. 测源码安装

```bash
git clone https://github.com/ykzhujiang/cfbrain-clean.git && cd cfbrain-clean
./install.sh
```
预期结尾：`ok doctor passed` + `CFBrain is installed.`

### ⚠️ 装完先确认 bun 在 PATH 里

如果 `install.sh` 帮你装了 Bun，它**改不了你当前 shell 的 PATH**（子进程无法修改父 shell 环境）。
所以脚本成功了，下一条命令却会报 `bun: command not found`。

```bash
command -v bun || export PATH="$HOME/.bun/bin:$PATH"
bun --version        # 有输出才继续
```

install.sh 结尾会显式提醒这一步。**这不是安装失败。**

```bash
bun test
```
**预期：`1078 pass · 119 skip · 2 fail`**
（119 个 skip 是需要外部 Postgres 的 E2E，正常。
2 个 fail 是 `check-update` 的两个用例：它们会请求 GitHub releases API，
但测试写了 5 秒硬超时。未发布 release 或网络慢时必超时，
手动跑 `cfbrain check-update --json` 是正常的。**除此之外的 fail 都是问题**。）

```bash
bun link          # 之后可以全局用 cfbrain
cfbrain --help
```

---

## C. 一分钟速查表

| 测什么 | 命令 | 预期 |
|---|---|---|
| 二进制自包含 | `./scripts/verify-binary.sh` | `11 passed, 0 failed` |
| 源码测试 | `bun test` | `1078 pass · 2 fail`（fail 仅 check-update 超时）|
| 装得起来 | `./install.sh` | `doctor passed` |
| 能读写 | `put` → `get` → `list` | 三步都有输出 |
| 分类可改 | `types add/remove` | 新类型能录、删掉的被拒 |
| 别的 Agent 能写 | `verify-binary.sh` 第 8 步 | `MCP put_page` PASS |
| **数据不外泄** | `git remote -v` in `~/.cfbrain` | **空**（无远端） |
| **key 不进 git** | `git check-ignore config.json` | 已忽略 |
| 飞书前置检测 | `cfbrain feishu setup --check` | 三项状态清楚 |

---

## D. 已知的正常现象（不是 bug，别误报）

| 现象 | 说明 |
|---|---|
| `doctor` 里 `pgvector` / `rls` 是 `warn` | 本地 PGLite 模式查不到，正常 |
| `embeddings: No embeddings yet` | 没配 `OPENAI_API_KEY` 或没跑 `repair --embed`，正常 |
| 中文关键词搜不到 | `search` 用 Postgres tsvector，不切中文词。中文请用 `query`（需要 API key） |
| `import` 后 `backlinks` 是空的 | 要再跑一次 `repair --links` 才建图，这是设计如此（大批量导入时更快） |
| `bun test` 有 119 个 skip | 需要外部 `DATABASE_URL` 的 E2E，正常 |
| 二进制第一次启动稍慢 | 首次要把扩展包解到临时目录，之后就快了 |
| `~/.cfbrain` 里 `git remote -v` 是空的 | **这是对的** —— 默认不同步，要同步得自己加 remote |
| `git status` 在 `put` 之后是干净的 | `put` 会自动本地 commit，不是没生效 |
| `cfbrain config set` 后 `config.json` 没变 | 那个命令写的是数据库，不是 config.json |
| `install.sh` 成功但 `bun` 找不到 | **不是失败** —— 加 `export PATH="$HOME/.bun/bin:$PATH"` 即可 |

---

## E. 真出问题时给我什么信息

```bash
./scripts/verify-binary.sh > /tmp/report.txt 2>&1
cfbrain doctor --json >> /tmp/report.txt 2>&1
cfbrain version >> /tmp/report.txt 2>&1
```
把 `/tmp/report.txt` 发我即可。里面不含任何密钥。
