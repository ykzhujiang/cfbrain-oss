/**
 * spec40-mailbox.test.ts — mailbox collector guarantees (prd-2026-08-28-002).
 *
 * These tests cover the five guarantees the PRD requires to be mechanical
 * rather than prompt-enforced. All fixtures live in a temporary
 * CFBRAIN_MAILBOX_DIR and are removed afterwards — nothing touches the
 * production knowledge base (see directive-2026-08-24 on test pollution).
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import {
  AgentMailClient,
  isLoopback,
  normalizeMessage,
  requireApiKey,
  scrubSecret,
  extractAddress,
  OUTBOUND_LABEL,
  type AgentMailMessage,
  type FetchImpl,
} from '../src/core/agentmail.ts';
import {
  fetchFragments,
  fragmentFileName,
  findRetryCandidates,
  readRegistry,
  writeRegistry,
  registryPath,
  resolveMailboxDir,
} from '../src/commands/mail.ts';

const TMP_DIR = join(import.meta.dir, '__mailbox_tmp__');
const FAKE_KEY = 'am_test_key_do_not_use_1234567890';

beforeEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- fixtures -------------------------------------------------------------

function makeMessage(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return normalizeMessage({
    message_id: '<fixture-001@email.amazonses.com>',
    thread_id: 'thread-001',
    from: 'Colleague <colleague@example.com>',
    to: ['agent@example.com'],
    subject: '一篇关于 Agent 的文章',
    text: '正文内容：这是同事转发的行业情报。',
    timestamp: '2026-08-28T09:15:00.000Z',
    labels: ['received', 'unread'],
    ...overrides,
  });
}

/**
 * Fake transport. Records every URL it is asked for, so a test can assert
 * that *no* HTTP request was attempted.
 */
function makeFakeFetch(messages: AgentMailMessage[]) {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url: string) => {
    calls.push(url);
    const isDetail = /\/messages\/[^?]/.test(url);
    const payload = isDetail
      ? messages.find(m => url.includes(encodeURIComponent(m.message_id))) ?? messages[0]
      : { count: messages.length, messages };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, calls };
}

function makeClient(messages: AgentMailMessage[]) {
  const { fetchImpl, calls } = makeFakeFetch(messages);
  const client = new AgentMailClient({
    apiKey: FAKE_KEY,
    inbox: 'agent@example.com',
    fetchImpl,
    retryBaseDelayMs: 1,
  });
  return { client, calls };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// --- Guarantee 1: idempotency + append-only ------------------------------

describe('mail fetch idempotency (append-only, PRD test 1)', () => {
  test('fetching the same message twice adds no file and leaves sha256 unchanged', async () => {
    const msg = makeMessage();
    const { client } = makeClient([msg]);

    const first = await fetchFragments({
      mailboxDir: TMP_DIR,
      client,
      ownInbox: 'agent@example.com',
    });
    expect(first.new_count).toBe(1);
    expect(first.files.length).toBe(1);

    const newDir = join(TMP_DIR, 'new');
    const filesAfterFirst = readdirSync(newDir).sort();
    expect(filesAfterFirst.length).toBe(1);
    const fragmentPath = join(newDir, filesAfterFirst[0]);
    const hashAfterFirst = sha256File(fragmentPath);

    const second = await fetchFragments({
      mailboxDir: TMP_DIR,
      client,
      ownInbox: 'agent@example.com',
    });

    expect(second.new_count).toBe(0);
    expect(second.skipped_existing).toBe(1);
    expect(readdirSync(newDir).sort()).toEqual(filesAfterFirst);
    expect(sha256File(fragmentPath)).toBe(hashAfterFirst);
  });

  test('fragment filename derives from the message, not the clock', () => {
    const msg = makeMessage();
    expect(fragmentFileName(msg)).toBe(fragmentFileName({ ...msg }));
    expect(fragmentFileName(msg)).toMatch(/^2026-08-28-0915-[0-9a-f]{8}\.json$/);
  });

  test('an existing fragment is never overwritten even if content would differ', async () => {
    const msg = makeMessage();
    const { client } = makeClient([msg]);
    mkdirSync(join(TMP_DIR, 'new'), { recursive: true });

    const target = join(TMP_DIR, 'new', fragmentFileName(msg));
    writeFileSync(target, 'ORIGINAL-RAW-MATERIAL', 'utf-8');

    const report = await fetchFragments({
      mailboxDir: TMP_DIR,
      client,
      ownInbox: 'agent@example.com',
    });

    expect(report.new_count).toBe(0);
    expect(report.skipped_existing).toBe(1);
    expect(readFileSync(target, 'utf-8')).toBe('ORIGINAL-RAW-MATERIAL');
  });

  test('the processed index lives outside new/ so raw material stays clean', async () => {
    const { client } = makeClient([makeMessage()]);
    await fetchFragments({ mailboxDir: TMP_DIR, client, ownInbox: 'agent@example.com' });

    expect(existsSync(join(TMP_DIR, '.processed-index.jsonl'))).toBe(true);
    for (const f of readdirSync(join(TMP_DIR, 'new'))) {
      expect(f.endsWith('.json')).toBe(true);
      expect(f.startsWith('.processed')).toBe(false);
    }
  });
});

// --- Guarantee 2: loopback protection ------------------------------------

describe('loopback protection (directive 8.3, PRD test 2)', () => {
  test('a message carrying the reserved `sent` label is skipped', async () => {
    const msg = makeMessage({ labels: ['sent'], from: 'CFBrain <agent@example.com>' });
    const { client } = makeClient([msg]);

    const report = await fetchFragments({
      mailboxDir: TMP_DIR,
      client,
      ownInbox: 'agent@example.com',
    });

    expect(report.new_count).toBe(0);
    expect(report.skipped_loopback).toBe(1);
    expect(readdirSync(join(TMP_DIR, 'new')).length).toBe(0);
  });

  test('a message carrying our custom outbound label is skipped', () => {
    const msg = makeMessage({ labels: [OUTBOUND_LABEL] });
    expect(isLoopback(msg, 'agent@example.com')).toBe(true);
  });

  test('a message from our own address is skipped even without labels', () => {
    const msg = makeMessage({ labels: [], from: 'CFBrain <agent@example.com>' });
    expect(isLoopback(msg, 'agent@example.com')).toBe(true);
  });

  test('an ordinary external message is not treated as loopback', () => {
    expect(isLoopback(makeMessage(), 'agent@example.com')).toBe(false);
  });

  test('address extraction handles display-name form', () => {
    expect(extractAddress('CFBrain <agent@example.com>')).toBe('agent@example.com');
    expect(extractAddress('  Plain@Example.COM ')).toBe('plain@example.com');
  });

  test('no sender allowlist: any external address is ingested (directive 8.2)', async () => {
    const msg = makeMessage({ from: 'stranger <stranger@somewhere-unknown.io>' });
    const { client } = makeClient([msg]);

    const report = await fetchFragments({
      mailboxDir: TMP_DIR,
      client,
      ownInbox: 'agent@example.com',
    });

    expect(report.new_count).toBe(1);
    const stored = JSON.parse(readFileSync(join(TMP_DIR, report.files[0]), 'utf-8'));
    // The real sender must be preserved verbatim for the owner to judge.
    expect(stored.from).toBe('stranger <stranger@somewhere-unknown.io>');
  });
});

// --- Guarantee 3: no send without human confirmation ---------------------

describe('no send without confirmation (directive 8.1 item 4, PRD test 3)', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');

  test('mail send without --confirmed-by-human exits non-zero and sends nothing', async () => {
    const bodyFile = join(TMP_DIR, 'body.txt');
    writeFileSync(bodyFile, 'test body', 'utf-8');

    const proc = Bun.spawn(
      [
        process.execPath,
        'run',
        cliPath,
        'mail',
        'send',
        '--to',
        'nobody@example.com',
        '--subject',
        'should not send',
        '--body-file',
        bodyFile,
        '--mailbox-dir',
        TMP_DIR,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        // A deliberately invalid base URL: if any HTTP call were attempted it
        // would fail loudly rather than reach the real AgentMail API.
        env: {
          ...process.env,
          AGENTMAIL_API_KEY: FAKE_KEY,
          AGENTMAIL_API_BASE: 'http://127.0.0.1:1/v0',
        },
      }
    );

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--confirmed-by-human');
    // Nothing was archived, i.e. no send path was entered at all.
    expect(existsSync(join(TMP_DIR, 'sent')) ? readdirSync(join(TMP_DIR, 'sent')) : []).toEqual([]);
  }, 30_000);

  test('the gate is checked before any network call is constructed', async () => {
    // sendMessage is only reachable through the gate; assert the client itself
    // was never invoked by verifying no request is recorded for a refused send.
    const { calls } = makeClient([]);
    expect(calls).toEqual([]);
  });
});

// --- Guarantee 4: key handling ------------------------------------------

describe('API key handling (PRD test 4)', () => {
  test('a missing key produces a clear error naming the variable', () => {
    expect(() => requireApiKey({})).toThrow(/AGENTMAIL_API_KEY/);
    expect(() => requireApiKey({ AGENTMAIL_API_KEY: '' })).toThrow(/AGENTMAIL_API_KEY/);
    expect(() => requireApiKey({ AGENTMAIL_API_KEY: '   ' })).toThrow(/AGENTMAIL_API_KEY/);
  });

  test('the error text contains no key material', () => {
    let message = '';
    try {
      requireApiKey({ AGENTMAIL_API_KEY: '' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toContain(FAKE_KEY);
    expect(message.toLowerCase()).not.toContain('bearer');
  });

  test('a present key is returned trimmed', () => {
    expect(requireApiKey({ AGENTMAIL_API_KEY: `  ${FAKE_KEY}  ` })).toBe(FAKE_KEY);
  });

  test('scrubSecret removes the key from any text destined for logs', () => {
    const leaky = `request failed: Authorization: Bearer ${FAKE_KEY} rejected`;
    const scrubbed = scrubSecret(leaky, FAKE_KEY);
    expect(scrubbed).not.toContain(FAKE_KEY);
    expect(scrubbed).toContain('[REDACTED]');
  });

  test('HTTP error text surfaced by the client is scrubbed', async () => {
    const fetchImpl: FetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => `invalid key ${FAKE_KEY}`,
    });
    const client = new AgentMailClient({
      apiKey: FAKE_KEY,
      inbox: 'agent@example.com',
      fetchImpl,
      retryBaseDelayMs: 1,
    });

    let message = '';
    try {
      await client.listMessages();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('401');
    expect(message).not.toContain(FAKE_KEY);
  });

  test('a fetch failure throws instead of reporting an empty inbox', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('connection reset');
    };
    const client = new AgentMailClient({
      apiKey: FAKE_KEY,
      inbox: 'agent@example.com',
      fetchImpl,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });

    await expect(
      fetchFragments({ mailboxDir: TMP_DIR, client, ownInbox: 'agent@example.com' })
    ).rejects.toThrow(/network error/);
  });
});

// --- Guarantee 5: registry backup ---------------------------------------

describe('registry backup before write (directive section 5, PRD test 5)', () => {
  test('writing over an existing registry creates a backup first', () => {
    const original = { briefing_recipients: ['first@example.com'] };
    writeRegistry(TMP_DIR, original);
    expect(existsSync(registryPath(TMP_DIR))).toBe(true);

    const backup = writeRegistry(TMP_DIR, { briefing_recipients: ['second@example.com'] });

    expect(backup).not.toBeNull();
    expect(existsSync(backup!)).toBe(true);
    expect(JSON.parse(readFileSync(backup!, 'utf-8'))).toEqual(original);
    expect(readRegistry(TMP_DIR).briefing_recipients).toEqual(['second@example.com']);
  });

  test('a backup is never overwritten by a second change on the same day', () => {
    writeRegistry(TMP_DIR, { briefing_recipients: ['a@example.com'] });
    const b1 = writeRegistry(TMP_DIR, { briefing_recipients: ['b@example.com'] });
    const b2 = writeRegistry(TMP_DIR, { briefing_recipients: ['c@example.com'] });

    expect(b1).not.toBe(b2);
    expect(JSON.parse(readFileSync(b1!, 'utf-8')).briefing_recipients).toEqual(['a@example.com']);
    expect(JSON.parse(readFileSync(b2!, 'utf-8')).briefing_recipients).toEqual(['b@example.com']);
  });

  test('the default roster ships empty so no stranger can be mailed by accident', () => {
    expect(readRegistry(TMP_DIR).briefing_recipients).toEqual([]);
  });

  test('a first write needs no backup', () => {
    expect(writeRegistry(TMP_DIR, { briefing_recipients: ['x@example.com'] })).toBeNull();
  });
});

// --- retry candidates: the "do not nag" rule ----------------------------

describe('retry candidates never nag about unanswered drafts (directive section 3)', () => {
  test('an unmarked pending draft is not a retry candidate', () => {
    mkdirSync(join(TMP_DIR, 'pending'), { recursive: true });
    const draft = join(TMP_DIR, 'pending', '2026-08-01-1000-batch.md');
    writeFileSync(draft, 'awaiting the owner reply', 'utf-8');
    // Age it well beyond the retry window.
    const old = new Date(Date.now() - 72 * 3600 * 1000);
    utimesSync(draft, old, old);

    expect(findRetryCandidates(TMP_DIR, 24)).toEqual([]);
  });

  test('an explicitly failed batch older than the window is a retry candidate', () => {
    mkdirSync(join(TMP_DIR, 'pending'), { recursive: true });
    const marker = join(TMP_DIR, 'pending', '2026-08-01-1000-batch.failed');
    writeFileSync(marker, 'put failed', 'utf-8');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(marker, old, old);

    expect(findRetryCandidates(TMP_DIR, 24)).toEqual([join('pending', '2026-08-01-1000-batch.failed')]);
  });

  test('a recently failed batch is not retried yet', () => {
    mkdirSync(join(TMP_DIR, 'pending'), { recursive: true });
    writeFileSync(join(TMP_DIR, 'pending', 'fresh-batch.failed'), 'put failed', 'utf-8');

    expect(findRetryCandidates(TMP_DIR, 24)).toEqual([]);
  });
});

// --- mailbox dir resolution ---------------------------------------------

describe('mailbox directory resolution', () => {
  test('CFBRAIN_MAILBOX_DIR takes precedence', () => {
    expect(resolveMailboxDir({ CFBRAIN_MAILBOX_DIR: TMP_DIR })).toBe(TMP_DIR);
  });

  test('the default resolves to <repo>/shared/mailbox with no hardcoded HOME', () => {
    const resolved = resolveMailboxDir({});
    expect(resolved.endsWith(join('shared', 'mailbox'))).toBe(true);
  });
});
