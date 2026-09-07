# Agent Templates

The multi-agent architecture CFBrain was built to serve. **These are templates,
not runnable configuration** — every environment-specific value is a
`<PLACEHOLDER>` you must fill in.

You can use CFBrain purely as a CLI and ignore this directory entirely.

---

## The architecture

```
                    ┌──────────────────────────────┐
                    │  Main Agent                  │
                    │  does the knowledge work     │
                    │  capture · retrieve · audit  │
                    └───────────┬──────────────────┘
                                │ files improvement requests
                                ▼
   ┌────────────┐  PRD   ┌─────────────┐  result  ┌─────────────┐
   │  Planner   ├───────►│  Generator  ├─────────►│  Evaluator  │
   │ what next  │        │  implements │          │  gates it   │
   └─────▲──────┘        └─────────────┘          └──────┬──────┘
         │                                                │
         └────────────────  feedback  ────────────────────┘
```

**Main** operates the knowledge base for a human owner.
**Planner → Generator → Evaluator** is a closed loop that improves the system
itself: Planner decides what to fix, Generator writes the code, Evaluator gates it
before anything reaches production. Main never edits its own tooling — that
separation is what keeps the loop safe.

---

## Layout

| Path | Purpose |
|---|---|
| `main/AGENTS.md` | Knowledge capture, retrieval, audit and reporting workflows |
| `planner/AGENTS.md` | Prioritises improvements, writes PRDs |
| `generator/AGENTS.md` | Implements changes against a staging gate |
| `evaluator/AGENTS.md` | Tests, approves and deploys; the only role that may merge |
| `shared/control/guardrails.md` | Red lines that no agent may cross |
| `shared/context/profile.md` | **Who you are** — fill this in first |
| `shared/context/goals.md` | What you're trying to achieve |
| `shared/context/rules.md` | Domain-specific conventions |
| `shared/eval/` | Metrics and regression test cases |
| `shared/scripts/` | Orchestration, cron entry point, deploy |
| `launchd/` | macOS scheduled job definitions |

---

## Setup

**1. Fill in your context.** The agent's judgement is only as good as this:

```
shared/context/profile.md    ← start here
shared/context/goals.md
shared/context/rules.md
```

**2. Replace every placeholder.** Find them all with:

```bash
grep -rn '<[A-Z_]*>' . | grep -v README
```

Expect these:

| Placeholder | Meaning |
|---|---|
| `<OWNER>` | The human the agent works for |
| `<YOUR_COMPANY>` | Your organisation name |
| `<YOUR_OPENAI_API_KEY>` | Put the real key in `.env`, not here |
| `<YOUR_FEISHU_APP_ID>` / `<YOUR_FEISHU_SPACE_ID>` | Feishu integration only |
| `<YOUR_FEISHU_OWNER_OPEN_ID>` / `<YOUR_FEISHU_BOT_OPEN_ID>` | Feishu user/bot IDs |
| `<NODE_TOKEN_*>` | Feishu wiki node per page type |
| `<your-org>.feishu.cn` | Your Feishu tenant domain |
| `$CFBRAIN_HOME` / `$CFBRAIN_DATA_HOME` | Repo path / brain data path |

**3. Set your paths:**

```bash
export CFBRAIN_HOME=/path/to/cfbrain-oss
export CFBRAIN_DATA_HOME=$HOME/.cfbrain-data
```

**4. Ignore the Feishu parts** if you don't use Feishu. The knowledge workflows
work standalone; Feishu is only the presentation and comment-handling layer.

---

## Read the guardrails first

`shared/control/guardrails.md` encodes the rules that matter most, learned from
real failures:

- Never `put` without passing the full pre-write checklist
- Never fabricate — say "I don't know" and cite sources for everything
- Never lose raw source material
- Never force-push
- Never expose API keys

The `main/AGENTS.md` "Put Gate" is worth reading even if you never run these
agents. It is a checklist that blocks a write until source attribution, raw
material and speaker attribution have all been verified — the failure modes it
guards against are subtle and expensive.

---

## Honest caveats

- These prompts were written for **[OpenCode](https://opencode.ai)** and assume its
  agent/session model. Adapting to another harness takes work.
- They are long (~2,200 lines total) and were tuned against one specific person's
  workflow. Treat them as a **reference design**, not a drop-in.
- The business-specific context files ship intentionally empty. An agent running
  with empty `profile.md` will be generic and not very useful.
