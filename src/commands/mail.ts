/**
 * mail.ts — `cfbrain mail` subcommands (prd-2026-08-28-002).
 *
 * Division of labour: this file contains only mechanical actions (fetch, persist,
 * dedupe, send, registry I/O). Judgement — classifying a fragment, deciding what
 * is a duplicate, proposing recipients — stays with the Main Agent's LLM.
 *
 * Hard guarantees implemented here rather than in a prompt:
 *   - `new/` is append-only: files are written with the 'wx' flag, so an existing
 *     fragment is never overwritten, merged or deleted.
 *   - `mail send` refuses to send without --confirmed-by-human, and the refusal
 *     happens before any credential read or network call.
 *   - `registry.json` is backed up before every write, and a backup is never
 *     overwritten either.
 */

import { createHash } from 'crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import {
  AgentMailClient,
  AgentMailError,
  isLoopback,
  requireApiKey,
  resolveInbox,
  type AgentMailMessage,
} from '../core/agentmail.ts';

/**
 * Default recipient roster.
 *
 * Intentionally EMPTY in the open-source distribution: shipping real addresses
 * would leak them, and silently mailing a stranger's inbox is worse than doing
 * nothing. Populate it either by
 *   - `cfbrain mail registry set --briefing-recipients a@x.com,b@y.com`, or
 *   - the CFBRAIN_BRIEFING_RECIPIENTS env var (comma separated).
 */
const DEFAULT_BRIEFING_RECIPIENTS = (process.env.CFBRAIN_BRIEFING_RECIPIENTS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_RETRY_HOURS = 24;

export interface MailboxRegistry {
  briefing_recipients: string[];
}

/**
 * Resolve the mailbox root.
 *   1. CFBRAIN_MAILBOX_DIR (used by tests and by any relocation)
 *   2. <repo>/shared/mailbox, derived from this module's location.
 * No HOME or absolute path is hardcoded (prd-2026-06-18-003).
 */
export function resolveMailboxDir(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.CFBRAIN_MAILBOX_DIR;
  if (override && override.trim() !== '') return resolve(override.trim());
  // this file: <repo>/cfbrain-cli/src/commands/mail.ts
  const repoRoot = resolve(import.meta.dir, '..', '..', '..');
  return join(repoRoot, 'shared', 'mailbox');
}

export function ensureMailboxLayout(mailboxDir: string): void {
  for (const sub of ['new', 'pending', 'sent']) {
    mkdirSync(join(mailboxDir, sub), { recursive: true });
  }
}

/** Two-digit zero pad. */
const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * Deterministic fragment filename: YYYY-MM-DD-HHMM-<sha256(message_id)[0:8]>.json
 *
 * The timestamp comes from the *message*, never from the clock, so re-fetching
 * the same message always resolves to the same path. This is what makes
 * idempotency mechanical instead of index-dependent.
 */
export function fragmentFileName(msg: AgentMailMessage): string {
  const hash = createHash('sha256').update(msg.message_id).digest('hex').slice(0, 8);
  const d = new Date(msg.timestamp);
  const stamp = Number.isNaN(d.getTime())
    ? '0000-00-00-0000'
    : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  return `${stamp}-${hash}.json`;
}

/** The raw fragment stored under new/ — a faithful mirror of the message. */
export function fragmentPayload(msg: AgentMailMessage): Record<string, unknown> {
  return {
    message_id: msg.message_id,
    thread_id: msg.thread_id,
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    subject: msg.subject,
    text: msg.text,
    timestamp: msg.timestamp,
    labels: msg.labels,
  };
}

function processedIndexPath(mailboxDir: string): string {
  // Deliberately outside new/ so the raw-material directory stays uncontaminated.
  return join(mailboxDir, '.processed-index.jsonl');
}

export function readProcessedIndex(mailboxDir: string): Set<string> {
  const path = processedIndexPath(mailboxDir);
  const seen = new Set<string>();
  if (!existsSync(path)) return seen;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const entry = JSON.parse(trimmed) as { message_id?: string };
      if (entry.message_id) seen.add(entry.message_id);
    } catch {
      // A corrupt line must not block ingestion; skip it.
    }
  }
  return seen;
}

function appendProcessedIndex(mailboxDir: string, messageId: string, file: string): void {
  const line = JSON.stringify({
    message_id: messageId,
    file,
    processed_at: new Date().toISOString(),
  });
  appendFileSync(processedIndexPath(mailboxDir), line + '\n', 'utf-8');
}

/**
 * Batches in pending/ explicitly marked failed and older than retryHours.
 *
 * Deliberately narrow: an *unmarked* pending draft is NEVER a retry candidate.
 * That is the mechanical form of directive section 3 "确认超时（owner 未回）→ 不自动执行，不催".
 * Without this, a 30-minute task would keep re-nagging about an unanswered draft.
 */
export function findRetryCandidates(mailboxDir: string, retryHours: number): string[] {
  const pendingDir = join(mailboxDir, 'pending');
  if (!existsSync(pendingDir)) return [];
  const cutoffMs = Date.now() - retryHours * 3600 * 1000;
  const out: string[] = [];
  for (const name of readdirSync(pendingDir).sort()) {
    if (!name.endsWith('.failed')) continue;
    const full = join(pendingDir, name);
    try {
      if (statSync(full).mtimeMs <= cutoffMs) out.push(join('pending', name));
    } catch {
      // Race with removal — ignore.
    }
  }
  return out;
}

// --- registry -------------------------------------------------------------

export function registryPath(mailboxDir: string): string {
  return join(mailboxDir, 'registry.json');
}

export function readRegistry(mailboxDir: string): MailboxRegistry {
  const path = registryPath(mailboxDir);
  if (!existsSync(path)) {
    return { briefing_recipients: [...DEFAULT_BRIEFING_RECIPIENTS] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<MailboxRegistry>;
    const list = Array.isArray(parsed.briefing_recipients)
      ? parsed.briefing_recipients.map(String)
      : [...DEFAULT_BRIEFING_RECIPIENTS];
    return { briefing_recipients: list };
  } catch (e) {
    throw new Error(
      `registry.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Write registry.json, backing up any existing copy first (directive section 5).
 * A backup is never overwritten: if today's backup exists, a second-precision
 * name is used instead.
 */
export function writeRegistry(mailboxDir: string, registry: MailboxRegistry): string | null {
  mkdirSync(mailboxDir, { recursive: true });
  const path = registryPath(mailboxDir);
  let backup: string | null = null;

  if (existsSync(path)) {
    const now = new Date();
    const day = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    let candidate = join(mailboxDir, `registry.${day}.json`);
    if (existsSync(candidate)) {
      const time = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
      candidate = join(mailboxDir, `registry.${day}-${time}.json`);
    }
    copyFileSync(path, candidate);
    backup = candidate;
  }

  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  return backup;
}

// --- fetch ----------------------------------------------------------------

export interface FetchOptions {
  mailboxDir: string;
  limit?: number;
  retryHours?: number;
  client: AgentMailClient;
  ownInbox: string;
}

export interface FetchReport {
  mailbox_dir: string;
  inbox: string;
  new_count: number;
  files: string[];
  skipped_existing: number;
  skipped_loopback: number;
  retry_candidates: string[];
}

/**
 * Pull messages and persist unseen ones. Errors from the API propagate: a failed
 * fetch must not silently look like "no mail" and must not consume the message
 * (we never mark anything read server-side).
 */
export async function fetchFragments(options: FetchOptions): Promise<FetchReport> {
  const { mailboxDir, client, ownInbox } = options;
  ensureMailboxLayout(mailboxDir);

  const listing = await client.listMessages({ limit: options.limit ?? DEFAULT_FETCH_LIMIT });
  const processed = readProcessedIndex(mailboxDir);

  const files: string[] = [];
  let skippedExisting = 0;
  let skippedLoopback = 0;

  for (const summary of listing.messages) {
    if (!summary.message_id) continue;

    if (isLoopback(summary, ownInbox)) {
      skippedLoopback++;
      continue;
    }

    const fileName = fragmentFileName(summary);
    const relPath = join('new', fileName);
    const absPath = join(mailboxDir, relPath);

    if (existsSync(absPath) || processed.has(summary.message_id)) {
      skippedExisting++;
      continue;
    }

    // The list view carries no body; fetch the full message for `text`.
    const full = await client.getMessage(summary.message_id);

    // Re-check loopback with the detailed payload (labels/headers may be richer).
    if (isLoopback(full, ownInbox)) {
      skippedLoopback++;
      continue;
    }

    const body = JSON.stringify(fragmentPayload(full), null, 2) + '\n';
    try {
      // 'wx' = create-or-fail. This is the append-only guarantee: an existing
      // fragment can never be overwritten, even under a race.
      writeFileSync(absPath, body, { encoding: 'utf-8', flag: 'wx' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'EEXIST') {
        skippedExisting++;
        continue;
      }
      throw e;
    }

    appendProcessedIndex(mailboxDir, full.message_id, relPath);
    files.push(relPath);
  }

  return {
    mailbox_dir: mailboxDir,
    inbox: ownInbox,
    new_count: files.length,
    files,
    skipped_existing: skippedExisting,
    skipped_loopback: skippedLoopback,
    retry_candidates: findRetryCandidates(mailboxDir, options.retryHours ?? DEFAULT_RETRY_HOURS),
  };
}

// --- argument parsing -----------------------------------------------------

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string[]>;
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const booleanFlags = new Set(['--confirmed-by-human', '--dry-run', '--json']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    if (booleanFlags.has(arg)) {
      flags.add(arg);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      const list = values.get(arg) ?? [];
      list.push(next);
      values.set(arg, list);
      i++;
    }
  }
  return { flags, values };
}

function firstValue(parsed: ParsedArgs, key: string): string | undefined {
  return parsed.values.get(key)?.[0];
}

/** Split repeated and comma-joined address flags into a flat, deduped list. */
function addressList(parsed: ParsedArgs, key: string): string[] {
  const raw = parsed.values.get(key) ?? [];
  const out: string[] = [];
  for (const item of raw) {
    for (const part of item.split(',')) {
      const addr = part.trim();
      if (addr !== '' && !out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

// --- subcommand handlers --------------------------------------------------

async function runFetch(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const mailboxDir = firstValue(parsed, '--mailbox-dir')
    ? resolve(firstValue(parsed, '--mailbox-dir')!)
    : resolveMailboxDir();

  const limitRaw = firstValue(parsed, '--limit');
  const retryRaw = firstValue(parsed, '--retry-hours');

  const client = new AgentMailClient();
  const report = await fetchFragments({
    mailboxDir,
    client,
    ownInbox: client.inbox,
    limit: limitRaw ? Number(limitRaw) : undefined,
    retryHours: retryRaw ? Number(retryRaw) : undefined,
  });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function runSend(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  // --- Confirmation gate ---------------------------------------------------
  // Checked FIRST, before any credential read or network call, so that
  // "no send without Zhu Jiang's confirmation" is enforced by an exit code
  // rather than by prompt discipline. Prompts can be talked around; this cannot.
  if (!parsed.flags.has('--confirmed-by-human')) {
    console.error(
      'Refusing to send: --confirmed-by-human is required.\n' +
        'Every outbound message must be explicitly confirmed by the owner first ' +
        '(directive 8.1 item 4: there is no automatic send path).'
    );
    process.exit(1);
  }

  const to = addressList(parsed, '--to');
  const cc = addressList(parsed, '--cc');
  const subject = firstValue(parsed, '--subject');
  const bodyFile = firstValue(parsed, '--body-file');
  const mailboxDir = firstValue(parsed, '--mailbox-dir')
    ? resolve(firstValue(parsed, '--mailbox-dir')!)
    : resolveMailboxDir();

  if (to.length === 0 || !subject || !bodyFile) {
    console.error(
      'Usage: cfbrain mail send --to <addr,...> --subject <s> --body-file <path> ' +
        '--confirmed-by-human [--cc <addr,...>] [--dry-run]'
    );
    process.exit(1);
  }

  if (!existsSync(bodyFile)) {
    console.error(`Body file not found: ${bodyFile}`);
    process.exit(1);
  }
  const body = readFileSync(bodyFile, 'utf-8');

  const dryRun = parsed.flags.has('--dry-run');
  ensureMailboxLayout(mailboxDir);

  let result = { message_id: '(dry-run)', thread_id: '(dry-run)' };
  if (!dryRun) {
    const client = new AgentMailClient();
    result = await client.sendMessage({ to, cc: cc.length ? cc : undefined, subject, body });
  }

  const now = new Date();
  const stamp =
    `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-` +
    `${p2(now.getHours())}${p2(now.getMinutes())}`;
  const archive = join(mailboxDir, 'sent', `${stamp}-batch.md`);

  // appendFileSync: the sent archive is append-only, never rewritten.
  appendFileSync(
    archive,
    [
      `## ${now.toISOString()}${dryRun ? ' (dry-run)' : ''}`,
      `- to: ${to.join(', ')}`,
      ...(cc.length ? [`- cc: ${cc.join(', ')}`] : []),
      `- subject: ${subject}`,
      `- message_id: ${result.message_id}`,
      `- confirmed_by_human: true`,
      '',
      body.trimEnd(),
      '',
      '',
    ].join('\n'),
    'utf-8'
  );

  process.stdout.write(
    JSON.stringify(
      {
        sent: !dryRun,
        dry_run: dryRun,
        to,
        cc,
        subject,
        message_id: result.message_id,
        thread_id: result.thread_id,
        archive,
      },
      null,
      2
    ) + '\n'
  );
}

function runRegistry(args: string[]): void {
  const action = args[0] ?? 'show';
  const parsed = parseArgs(args.slice(1));
  const mailboxDir = firstValue(parsed, '--mailbox-dir')
    ? resolve(firstValue(parsed, '--mailbox-dir')!)
    : resolveMailboxDir();

  if (action === 'show') {
    const registry = readRegistry(mailboxDir);
    process.stdout.write(
      JSON.stringify(
        {
          registry_path: registryPath(mailboxDir),
          exists: existsSync(registryPath(mailboxDir)),
          ...registry,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (action === 'set') {
    const recipients = addressList(parsed, '--briefing-recipients');
    if (recipients.length === 0) {
      console.error(
        'Usage: cfbrain mail registry set --briefing-recipients <addr,...> [--mailbox-dir <dir>]'
      );
      process.exit(1);
    }
    const backup = writeRegistry(mailboxDir, { briefing_recipients: recipients });
    process.stdout.write(
      JSON.stringify(
        { registry_path: registryPath(mailboxDir), backup, briefing_recipients: recipients },
        null,
        2
      ) + '\n'
    );
    return;
  }

  console.error(`Unknown registry action: ${action}. Expected 'show' or 'set'.`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`Usage: cfbrain mail <subcommand>

Subcommands:
  fetch [--json] [--limit N] [--retry-hours N] [--mailbox-dir <dir>]
      Pull new messages into <mailbox>/new/ (append-only) and print a JSON report.

  send --to <addr,...> --subject <s> --body-file <path> --confirmed-by-human
       [--cc <addr,...>] [--dry-run] [--mailbox-dir <dir>]
      Send a message. Refuses to run without --confirmed-by-human.

  registry show [--mailbox-dir <dir>]
  registry set --briefing-recipients <addr,...> [--mailbox-dir <dir>]
      Read or update the recipient roster (a backup is written before any change).

Environment:
  AGENTMAIL_API_KEY     required for fetch/send (never passed on the CLI)
  AGENTMAIL_INBOX       inbox id (required; no default recipient is shipped)
  CFBRAIN_MAILBOX_DIR   overrides <repo>/shared/mailbox
`);
}

export async function runMail(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    return;
  }

  try {
    switch (sub) {
      case 'fetch':
        await runFetch(rest);
        return;
      case 'send':
        await runSend(rest);
        return;
      case 'registry':
        runRegistry(rest);
        return;
      default:
        console.error(`Unknown mail subcommand: ${sub}`);
        printHelp();
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof AgentMailError) {
      console.error(`AgentMail error: ${e.message}`);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

/** Re-exported so the precheck/tests can assert key handling without a client. */
export { requireApiKey, resolveInbox };
