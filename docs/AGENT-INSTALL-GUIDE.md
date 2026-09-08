# CFBrain 安装验收指南（给 Agent 执行）

> **这份文档是写给 AI Agent 看的执行脚本，不是给人读的教程。**
>
> 如果你是 Agent：请从头到尾按顺序执行，每步都做验证，最后按第 9 节的模板输出报告。
> 遇到「⛔ 停下问人」标记时，必须停下等人回答，不要自行决定。

---

## 0. 你的任务

在一台**干净的机器**上安装 CFBrain 并验收。这是一次**首次安装验收测试**，目的是发现开发者在自己机器上测不出来的问题。

**重点验证以下 4 项**（这些是目前尚未在干净环境验证过的）：

| 编号 | 待验证项 | 为什么重要 |
|---|---|---|
| U1 | 干净机器上的完整安装流程 | 开发机有残留环境，测不准 |
| U2 | `npm install -g @larksuite/cli` 真的能装上 | 开发机早已装好，没法制造未安装状态 |
| U3 | 飞书端到端：接知识库 + 推送成功 | 需要一次性知识库，不能用生产库测 |
| U4 | Linux 平台（如果这台是 Linux） | 二进制编了但从未在 Linux 运行过 |
| U5 | 用户数据不外泄、API key 不进 git | 安全默认值刚改过，必须在干净机器上确认生效 |

### 行为约束（必须遵守）

- ✅ 可以安装：Bun、Node.js/npm、`@larksuite/cli`
- ❌ **不要**改动这台机器上与本任务无关的任何配置
- ❌ **不要**把任何东西提交到 git 或推送
- ❌ **不要**使用任何生产/正在用的飞书知识库，只用本次新建的一次性知识库
- ❌ **不要**把 API key、token 写进任何文件或报告里
- ⛔ 任何需要花钱、需要授权、可能影响他人的操作，先停下问人

---

## 1. 拿代码

仓库是公开的，直接 clone：

```bash
git clone https://github.com/ykzhujiang/cfbrain-oss.git
cd cfbrain-oss
export REPO="$PWD"      # 后面会用到，记住这个路径
echo "$REPO"
```

**预期**：clone 成功，目录里有 `README.md`、`install.sh`、`src/`、`docs/`。

如果失败，记下完整错误后 ⛔ 停下问人。**不要尝试绕过。**

---

## 2. 记录环境基线

```bash
uname -s -m
sw_vers 2>/dev/null || cat /etc/os-release 2>/dev/null | head -3
command -v bun && bun --version || echo "bun: 未安装"
command -v node && node --version || echo "node: 未安装"
command -v npm && npm --version || echo "npm: 未安装"
command -v lark-cli && lark-cli --version || echo "lark-cli: 未安装"
```

**把这些原样记下来，报告里要用。**

> 📌 **关键**：如果 `lark-cli` 显示「未安装」，那太好了 —— 这台机器正好能验证 **U2**。请在第 6 节认真测它。
> 如果已经装了，就在报告里注明「U2 无法验证：本机已装」。

---

## 3. 安装

```bash
./install.sh
```

**预期结尾包含：**

```
    ok  doctor passed

  CFBrain is installed.
```

**判定：**

| 情况 | 怎么做 |
|---|---|
| 看到 `doctor passed` | ✅ 通过，继续 |
| 卡住超过 5 分钟不动 | 记下卡在哪一行，⛔ 停下问人 |
| 报错 | **完整复制错误全文**，继续尝试第 4 节；若第 4 节也失败则 ⛔ 停下问人 |

> ℹ️ 输出里 `lark-cli not installed` 是**正常的**，不是错误 —— 飞书是可选的，第 6 节再处理。

---

## 3.5 把 Bun 加进 PATH（⚠️ 最容易在这里失败）

**这一步必做，否则后面每条命令都会报 `bun: command not found`。**

原因：`install.sh` 如果帮你装了 Bun，它只能改自己进程的 PATH —— **子进程无法修改父 shell 的环境变量**。所以脚本成功了，但你的 shell 仍然找不到 `bun`。

先检查：

```bash
command -v bun && bun --version || echo "bun 不在 PATH"
```

**如果显示「bun 不在 PATH」**，执行：

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

**必须在同一个 shell 会话里继续后面所有步骤。** 如果你每条命令都是新开一个 shell 执行，
那就在**每条**命令前都加上 `export PATH="$HOME/.bun/bin:$PATH" && `，例如：

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test 2>&1 | tail -6
```

**判定：** `bun --version` 有输出才算通过。没有就 ⛔ 停下问人，别继续往下走。

---

## 4. 跑测试套件

```bash
bun test 2>&1 | tail -6
```

**预期：**

```
 1080 pass
 119 skip
 0 fail
```

**判定：**

- `0 fail` → ✅ 通过
- 任何 `fail > 0` → ❌ **失败，这是真问题**。把失败的测试名和错误完整记下来
- `pass` 数字与 1080 略有差异但 `0 fail` → ✅ 通过，但在报告里注明实际数字

> ℹ️ `119 skip` 是**正常的** —— 那些测试需要外部 Postgres 数据库。

---

## 5. 验证单文件二进制（核心项 U1 / U4）

```bash
bun run build
./scripts/verify-binary.sh
```

**预期最后三行：**

```
  11 passed, 0 failed

The binary is self-contained. It ran with no bun, no source tree,
no node_modules and an empty environment.
```

**判定：**

- `11 passed, 0 failed` → ✅ 通过
- 任何 `FAIL` → ❌ **失败**。脚本会打印是哪一步，**把那一步和错误全文记下来**

> 这一步在验证：二进制不依赖任何外部环境。脚本会把它拷到空目录、清空所有环境变量再跑。
>
> **如果这台是 Linux，这一项的结果特别重要（U4）** —— 之前从未在 Linux 上运行过。

---

## 6. 验证飞书自动安装（核心项 U2）

⛔ **先停下问人**：「接下来要在这台机器上装 `@larksuite/cli`（npm 全局包），并用飞书账号授权。请确认：(1) 可以装吗？(2) 用哪个飞书账号授权？」

**得到明确同意后**才继续。

### 6.1 先只检查，不安装

```bash
bun run src/cli.ts feishu setup --check
```

记下输出。预期会显示 `lark-cli is not installed`（如果本机确实没装）。

### 6.2 执行引导安装

```bash
bun run src/cli.ts feishu setup
```

**它会问你「Install @larksuite/cli globally via npm now? [Y/n]」—— 回答 `y`。**

**这一步就是 U2 的核心验证。** 请完整记录：

- npm 安装成功了吗？
- 如果失败，是不是权限问题（`EACCES`）？错误全文是什么？
- 安装后 `lark-cli` 在 PATH 里吗？

**判定：**

| 情况 | 结论 |
|---|---|
| 装上了，且 `lark-cli --version` 有输出 | ✅ U2 通过 |
| 报 `EACCES` / 权限错误 | ❌ U2 失败 —— **记下来，这是要修的真问题**。脚本应该给了 sudo 或改 prefix 的建议，照做后能成功吗？ |
| 装上了但 `lark-cli` 不在 PATH | ❌ U2 部分失败，记下 `npm bin -g` 的输出 |
| 没 npm，脚本让你先装 Node.js | 按提示装 Node.js 后重来 |

### 6.3 完成配置与授权

脚本会继续引导 `lark-cli config init --new` 和 `lark-cli auth login`，两者都会输出一个**验证 URL**。

- 把 URL 交给人在浏览器打开完成
- ⛔ 如果你无法把 URL 交给人，停下问人

完成后重跑检查：

```bash
bun run src/cli.ts feishu setup --check
```

**预期三项全绿：**

```
1. lark-cli        ok  lark-cli is installed
2. Feishu app      ok  configured (app cli_xxxx)
3. Authorisation   ok  logged in as <名字>
```

> ❌ **报告里不要写 app id 和任何 token**，写「已配置」就行。

---

## 7. 验证自定义分类

```bash
bun run src/cli.ts types list
bun run src/cli.ts types add paper --label "论文"
bun run src/cli.ts types remove deal
bun run src/cli.ts types list
```

**预期：** `Added type "paper"...` 和 `Removed type "deal".`，且最后的 list 里有 `paper` 没有 `deal`。

再验证规则真生效：

```bash
printf -- '---\ntitle: 一篇论文\ntypes: [paper]\n---\n\n内容\n' > /tmp/ok.md
bun run src/cli.ts put test-paper --content-file /tmp/ok.md --no-embed

printf -- '---\ntitle: 应该失败\ntypes: [deal]\n---\n\n内容\n' > /tmp/bad.md
bun run src/cli.ts put test-fail --content-file /tmp/bad.md --no-embed
```

**预期：**
- 第一条成功，返回 `"status": "created_or_updated"`
- 第二条**报错**（这是正确行为）：`Error [invalid_params]: Invalid type(s): deal.`

**判定：** 第二条如果**成功了**，那是 ❌ 失败（类型校验没生效）。

---

## 7.5 验证数据不外泄 + key 不进 git（核心项 U5）

**这一节最重要，必须做。** 它验证使用者不会因为用默认配置就泄漏自己的 API key。

背景：`init` 会把 `~/.cfbrain` 变成 git 仓库，且每次 `put` 会自动本地 commit。
所以「哪些文件没被 ignore」直接决定了使用者 push 时会泄漏什么。

用一个**假 key** 来测（不要用真 key）：

```bash
export TESTHOME=$(mktemp -d)
HOME=$TESTHOME bun run src/cli.ts init --pglite --non-interactive --key sk-faketestkey1234567890
cd $TESTHOME/.cfbrain
```

### 7.5.1 有没有配远端

```bash
git remote -v
```
**预期：完全没有输出。**

**判定：** 如果输出了任何远端地址 → ❌ **严重问题，立刻停下报告**。这意味着用户数据可能被推到别处。

### 7.5.2 假 key 会被提交吗

```bash
cat .gitignore
git check-ignore -v config.json
git check-ignore -v brain.pglite
```
**预期：** `.gitignore` 里有 `config.json` 一条；两个 `check-ignore` 都**有输出**，形如：

```
.gitignore:3:config.json	config.json
.gitignore:9:*.pglite	brain.pglite
```

（`brain.pglite` 是被 `*.pglite` 规则命中的，行号可能不同，只要有输出即通过。）

**判定：** 任何一个**没有输出**（即未被忽略）→ ❌ **严重问题**。用户一 push 就会泄漏自己的 key。

### 7.5.3 一共几个文件会被提交

```bash
git add -A --dry-run
```
**预期：只有 1 行**，即 `add '.gitignore'`。

**判定：** 如果出现 `config.json` 或大量 `brain.pglite/...` → ❌ 严重问题。

### 7.5.4 自动 commit 收了什么

```bash
printf -- '---\ntitle: 测试\ntypes: [note]\n---\n\n内容\n' > $TESTHOME/t.md
cd "$REPO"          # $REPO = 你 clone 出来的 cfbrain-oss 目录
HOME=$TESTHOME bun run src/cli.ts put t1 --content-file $TESTHOME/t.md --no-embed
cd $TESTHOME/.cfbrain && git log --oneline --stat -1
```

**预期 commit 里只有这 4 个：**
```
 .gitignore
 CHANGELOG.md
 pages/t1.md
 raw/<日期>-t1.md
```

**判定：** 出现 `config.json` 或任何 `brain.pglite/` 文件 → ❌ **严重问题**。

### 7.5.5 确认假 key 真的在 config.json 里（反证）

```bash
grep -o 'openai_api_key' $TESTHOME/.cfbrain/config.json
```
**预期：** 有输出。

这一步是**反向验证**：证明 key 确实写进了那个文件，所以前面的「已忽略」才有意义。
如果这里没输出，说明 key 存在别处，请在报告里说明，不要直接判定通过。

```bash
rm -rf $TESTHOME    # 清理
```

> ❌ 报告里不要写出任何真实 key。假 key `sk-faketestkey...` 可以写。

---

## 8. 验证飞书端到端（核心项 U3）

⛔ **先停下问人**：「要建一个**一次性测试用**飞书知识库来验证推送。确认可以吗？建好后测完可以删。」

同意后，二选一：

### 方式 A：让 CFBrain 自动建（可能需要额外授权）

```bash
bun run src/cli.ts feishu init --create-space "CFBrain测试可删"
```

如果报缺 `wiki:space:write_only` 权限，⛔ 停下问人是否允许授权：

```bash
lark-cli auth login --scope "wiki:space:write_only"
```

### 方式 B：人手动建（不需额外授权）

请人在飞书里新建一个知识库，把 space id 给你（在 URL 里 `/wiki/space/<这段>`），然后：

```bash
bun run src/cli.ts feishu init --space-id <给你的id>
```

### 然后推送

```bash
bun run src/cli.ts feishu push --all
bun run src/cli.ts feishu status --json
```

**预期：** 推送无报错；飞书知识库里能看到按分类建好的目录，以及第 7 节创建的词条。

**请人肉眼确认飞书里真的出现了内容**，并记录：

- 目录建对了吗（应该每个分类一个目录，加一个 `🗑️ 废弃`）？
- 词条内容正确吗？
- 用第 7 节新加的 `paper` 分类，飞书里有对应的「论文」目录吗？

**判定：** 任何一项不对 → ❌ U3 失败，详细记下现象。

---

## 9. 输出报告（按这个格式）

```markdown
# CFBrain 干净机器安装验收报告

## 环境
- 系统：<uname -s -m 的输出>
- 版本：<sw_vers 或 /etc/os-release>
- 安装前已有：bun <版本或"无"> / node <> / npm <> / lark-cli <>

## 四个核心验证项
| 项 | 结论 | 说明 |
|---|---|---|
| U1 干净机器安装 | ✅/❌/未测 | |
| U2 npm 装 lark-cli | ✅/❌/无法验证(本机已装) | |
| U3 飞书端到端 | ✅/❌/未测 | |
| U4 Linux 平台 | ✅/❌/不适用(非 Linux) | |
| U5 数据不外泄 / key 不进 git | ✅/❌/未测 | |

## 各步骤结果
| 步骤 | 命令 | 结论 | 实际输出关键行 |
|---|---|---|---|
| 3 安装 | ./install.sh | ✅/❌ | |
| 4 测试 | bun test | ✅/❌ | x pass, y fail |
| 5 二进制 | verify-binary.sh | ✅/❌ | n passed, m failed |
| 6 飞书前置 | feishu setup | ✅/❌ | |
| 7 自定义分类 | types add/remove | ✅/❌ | |
| 7.5 数据不外泄 | git remote / check-ignore | ✅/❌ | |
| 8 飞书推送 | feishu push --all | ✅/❌ | |

## 遇到的问题
（每个问题写：第几步、执行了什么命令、完整错误输出、你怎么处理的、最后好了没）

## 卡住或需要人介入的地方
（哪些步骤我没法独立完成、为什么）

## 主观感受
（作为第一次装这个东西的人，哪一步最容易困惑？文档哪里说得不清楚？）
```

**报告要求：**

- ❌ **不要包含**任何 API key、token、app secret、验证 URL
- ✅ 错误信息要**完整原文**，不要概括成「安装失败」
- ✅ 没做的步骤明确写「未测」和原因，**不要留空或猜结果**
- ✅ 不确定是不是问题的，写进「遇到的问题」让人判断，不要自行判定为通过

---

## 10. ⚠️ 这些现象是正常的，不要报成 bug

Agent 最容易误报的就是这些，请对照：

| 你会看到 | 这是正常的，因为 |
|---|---|
| `bun test` 有 `119 skip` | 那些测试需要外部 Postgres |
| `doctor` 里 `pgvector` / `rls` 是 `warn` | 本地 PGLite 模式查不到这两项 |
| `doctor` 里 `No embeddings yet` | 没配 `OPENAI_API_KEY`，语义搜索才需要 |
| `install.sh` 里 `lark-cli not installed` | 飞书是可选的，第 6 节才装 |
| `install.sh` 成功了但 `bun` 找不到 | **不是安装失败** —— 见第 3.5 节，加一下 PATH 即可 |
| 用中文关键词 `search` 搜不到 | `search` 用的 tsvector 不切中文词，中文要用 `query`（需 API key） |
| `import` 之后 `backlinks` 返回 `[]` | 要再跑 `repair --links` 才建图，设计如此 |
| `put` 用未声明的分类被拒 | **这是正确行为**，不是 bug |
| 二进制第一次启动稍慢 | 首次要把 WASM 扩展解到临时目录 |
| `~/.cfbrain` 里 `git remote -v` 是空的 | **这是正确的** —— 默认不同步任何数据 |
| `put` 之后 `git status` 是干净的 | `put` 会自动本地 commit，不是没生效 |
| `cfbrain config set` 后 `config.json` 没变化 | 那个命令写数据库，不写 config.json |
| 二进制有 79MB（Linux 116MB） | 内嵌了 13.5MB WASM + Postgres 运行时 |

---

## 11. 收尾清理

```bash
rm -f /tmp/ok.md /tmp/bad.md
```

⛔ 询问人：「测试用的飞书知识库要删掉吗？本地的 `~/.cfbrain` 要删吗？」**不要自己决定删。**

保留 `~/.cfbrain` 和仓库目录，方便复现问题。
