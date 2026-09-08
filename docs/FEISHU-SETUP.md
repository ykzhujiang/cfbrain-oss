# Feishu 接入指南

回答三个问题：**用哪个知识库？怎么授权？分类怎么定？**

---

## 先讲清一个边界

CFBrain 的知识库本体是**完全自包含**的：下载一个二进制就能用，不需要装任何东西。

但**飞书同步不是**。它靠外部工具 `lark-cli` 干活，所以：

| 能力 | 二进制单独够不够 |
|---|---|
| 建知识库、录入、检索、图谱、MCP 给其他 Agent 用 | ✅ 够，什么都不用装 |
| 自定义分类（`cfbrain types`） | ✅ 够，纯本地改配置 |
| 同步到飞书知识库 | ❌ **不够**，要另外装 `lark-cli` 并授权 |

这是设计取舍：飞书的 OAuth、token 刷新、多身份（user/bot）很复杂，与其在 CFBrain 里重造一遍，不如复用官方 CLI。代价就是飞书这块多一个依赖。

**不用飞书的话，整个 CLI 一行配置都不需要。**

---

## 第一步：装 lark-cli 并授权

```bash
npm install -g @larksuite/cli     # 官方包
lark-cli config init --new        # 会输出一个验证 URL，浏览器打开完成配置
lark-cli auth login               # 登录授权
```

验证装好了：

```bash
lark-cli --version
```

> 这一步是在**他自己的飞书账号**上做的，跟你的账号无关。他授权给他自己的应用，数据进他自己的知识库。

---

## 第二步：决定用哪个知识库

两条路，选一条。

### 路线 A：让 CFBrain 自动建一个（省事）

```bash
cfbrain feishu init --create-space "我的知识库"
```

**需要一个额外权限**。第一次会报缺 scope，按提示授权一次即可：

```bash
lark-cli auth login --scope "wiki:space:write_only"
```

然后重跑那条 `feishu init`。

### 路线 B：自己在飞书建好，把 id 给 CFBrain（不需要额外权限）

1. 在飞书里手动新建一个知识库
2. 打开它，从地址栏抄 space id：
   ```
   https://xxx.feishu.cn/wiki/space/7100000000000000000
                                    ^^^^^^^^^^^^^^^^^^^ 这段就是
   ```
3. 接上：
   ```bash
   cfbrain feishu init --space-id 7100000000000000000
   ```

不确定选哪条就用 **B**，因为不用额外授权。

### `feishu init` 到底做了什么

1. 检查 `lark-cli` 装了没、授权了没
2. 把 `space_id` 写进 `~/.cfbrain/config.json`
3. **按当前的分类，每个建一个根目录**，并把各自的 node token 记下来
4. 建一个 `🗑️ 废弃` 目录，给删掉的词条用

**幂等**：重复跑不会建出重复目录，同名的会复用。

---

## 第三步：分类怎么定（重点）

### 分类是他自己的，默认那 10 个可以全扔

`init` 时会给一套默认分类，但**只是默认值**，存在 `~/.cfbrain/config.json` 的 `type_labels` 里：

```json
{
  "type_labels": {
    "person": "关键人物",
    "company": "公司/组织",
    "intel": "情报"
  }
}
```

`put` 校验的是**这个配置**，不是代码里的硬编码列表。所以改配置就等于改规则。

### 怎么改

```bash
cfbrain types list                          # 看现状（含每类词条数）
cfbrain types add paper --label "论文"       # 加自己的
cfbrain types remove deal                   # 删不要的（有词条时需 --force）
cfbrain types rename intel --label "行业情报" # 只改显示名
```

改完立刻生效：

```bash
# 用新分类 → 成功
cfbrain put my-paper --content-file p.md      # types: [paper]

# 用删掉的分类 → 被拒
Error [invalid_params]: Invalid type(s): deal.
Allowed types: person, company, ..., paper. Use --force to bypass.
```

### 和飞书的联动

- **飞书已接好时**，`types add` 会**自动在飞书建对应目录**并记下 token，不用手动建
- `types rename` 会同步改飞书目录名
- **建议顺序：先把分类定好，再 `feishu init`** —— 这样目录一次建对。反过来也能用（`types add` 会补建），只是多几步

### 为什么要限制分类

不是为了麻烦。分类一旦随手新增，图谱就查不动了——今天 `paper`、明天 `papers`、后天 `论文`，最后没有一个查询是可靠的。所以 `put` 默认拒绝未声明的类型，真要绕过用 `--force`。

---

## 完整流程（同学照着做）

```bash
# 1. 拿到二进制（编一个，或你给他）
chmod +x cfbrain && sudo mv cfbrain /usr/local/bin/

# 2. 建自己的知识库（纯本地，此时还不碰飞书）
cfbrain init --pglite --non-interactive

# 3. 定自己的分类
cfbrain types remove deal
cfbrain types add paper --label "论文"
cfbrain types list

# 4. 先在本地跑通再接飞书
echo '---
title: 第一条
types: [note]
---
测试' > /tmp/a.md
cfbrain put first --content-file /tmp/a.md --no-embed
cfbrain get first

# ---- 以下才需要飞书 ----

# 5. 装并授权 lark-cli
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login

# 6. 接上知识库
cfbrain feishu init --space-id <他的 space id>

# 7. 推送
cfbrain feishu push --all
cfbrain feishu status --json
```

---

## 语义搜索要一个 API key

关键词搜索（`search`）不需要。语义搜索（`query`）需要 embedding：

```bash
cfbrain config set openai_api_key sk-...
# 或用环境变量 OPENAI_API_KEY
```

用第三方兼容网关的话设 `OPENAI_BASE_URL`。

---

## 配置都放在哪

| 位置 | 内容 |
|---|---|
| `~/.cfbrain/config.json` | 引擎、数据库路径、**分类**、飞书 space_id 与目录 token、API key |
| `~/.cfbrain/pages/` | 词条 markdown（真源） |
| `~/.cfbrain/raw/` | 原始素材 |
| `~/.cfbrain/brain.pglite/` | 数据库（可从 `pages/` 重建） |
| lark-cli 自己的目录 | 飞书授权 token（**不在** CFBrain 里） |

`config.json` 可能含 API key，权限是 `0600`。**要把 `~/.cfbrain` 放 git 的话，仓库必须私有，且务必把 `config.json` 加进 `.gitignore`** —— 这个坑我们真踩过，见 `AUDIT-AND-STRIPPING.md`。

---

## 关于 HOME 的一个坑

CFBrain 把知识库放在 `$HOME/.cfbrain`。如果你想换位置而重设 `HOME`，`lark-cli` 会找不到授权（它的 token 在真实 home 里）。这时用：

```bash
HOME=/path/to/brain-home LARK_CLI_HOME=/Users/you cfbrain feishu push --all
```

`LARK_CLI_HOME` 只影响传给 `lark-cli` 的 HOME。正常安装用不到这个。

---

## 当前状态与未验证项

| 项 | 状态 |
|---|---|
| 二进制独立跑知识库 | ✅ 隔离环境实测 11/11 通过 |
| `types add/remove/rename` 本地生效 | ✅ 实测（新类型能录、删掉的被拒） |
| `feishu init` 缺 lark-cli 时给出可操作提示 | ✅ 实测 |
| `--create-space` 到 API 的链路 | ✅ 请求正确送达并拿到 API 响应 |
| `--create-space` 真建出空间 | ⚠️ **未端到端验证** —— 需要 `wiki:space:write_only` 授权，得账号持有者本人开浏览器批准 |
| `feishu init --space-id` + `push` 全链路 | ⚠️ **未在干净账号上验证** —— 需要一个一次性知识库，不能拿生产库试 |
| `types add` 自动建飞书目录 | ⚠️ 代码路径已确认，未端到端跑 |

后三项要真验证，得有一个**一次性飞书账号或一次性知识库**。拿生产知识库试会污染真实数据，所以我没做。
