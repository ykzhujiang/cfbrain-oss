/**
 * agentmail.ts — Thin AgentMail API client (prd-2026-08-28-002).
 *
 * Scope: mechanical transport only. All judgement (classify, dedupe semantics,
 * recipient suggestion) stays with the Main Agent's LLM.
 *
 * Verified against the live API on 2026-08-28:
 *   GET  /v0/inboxes/{inbox_id}/messages        -> { count, limit, next_page_token, messages[] }
 *   GET  /v0/inboxes/{inbox_id}/messages/{id}   -> message with `text` / `extracted_text`
 *   POST /v0/inboxes/{inbox_id}/messages/send   -> { message_id, thread_id }
 *
 * Reserved labels observed in the live inbox: `sent`, `received`, `unread`.
 *
 * Security invariants:
 *   - The API key is read only from process.env.AGENTMAIL_API_KEY.
 *   - No absolute path or HOME is hardcoded (see prd-2026-06-18-003).
 *   - Every thrown message passes through scrubSecret(), so no key fragment can
 *     reach stdout, stderr, logs or reports.
 *   - Failures are thrown, never swallowed: a failed fetch must not consume mail.
 */

export const DEFAULT_API_BASE = 'https://api.agentmail.to/v0';
/**
 * Default inbox id. Override with the AGENTMAIL_INBOX env var.
 * `agent@example.com` is a deliberately non-routable placeholder so an
 * unconfigured install cannot send mail to anyone's real inbox.
 */
export const DEFAULT_INBOX = process.env.AGENTMAIL_INBOX || 'agent@example.com';

/** Label stamped on every outbound message so inbound fetch can detect loopback. */
export const OUTBOUND_LABEL = 'cfbrain-outbound';
/** Header stamped on every outbound message (belt and braces with OUTBOUND_LABEL). */
export const OUTBOUND_HEADER = 'X-CFBrain-Origin';
export const OUTBOUND_HEADER_VALUE = 'outbound';

/** AgentMail reserved label applied to messages this inbox itself sent. */
export const SENT_LABEL = 'sent';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

export class AgentMailError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AgentMailError';
    this.status = status;
  }
}

export interface AgentMailMessage {
  message_id: string;
  thread_id?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  preview?: string;
  timestamp: string;
  labels: string[];
  inbox_id?: string;
}

export interface ListMessagesOptions {
  limit?: number;
  labels?: string[];
  after?: string;
  before?: string;
  ascending?: boolean;
  pageToken?: string;
}

export interface ListMessagesResult {
  count: number;
  messages: AgentMailMessage[];
  next_page_token?: string;
}

export interface SendMessageInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  labels?: string[];
  headers?: Record<string, string>;
}

export interface SendMessageResult {
  message_id: string;
  thread_id: string;
}

export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface AgentMailClientOptions {
  apiKey?: string;
  inbox?: string;
  apiBase?: string;
  fetchImpl?: FetchImpl;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Remove every occurrence of `secret` from `text`.
 * Applied to all outbound error text so a key can never leak into logs.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('[REDACTED]');
}

/**
 * Read the API key from the environment.
 * Throws a message that names the variable but never contains its value.
 */
export function requireApiKey(env: Record<string, string | undefined> = process.env): string {
  const key = env.AGENTMAIL_API_KEY;
  if (!key || key.trim() === '') {
    throw new AgentMailError(
      'AGENTMAIL_API_KEY is not set (or empty). Add it to main/.env; ' +
        'never pass the key on the command line.'
    );
  }
  return key.trim();
}

export function resolveInbox(env: Record<string, string | undefined> = process.env): string {
  const inbox = env.AGENTMAIL_INBOX;
  return inbox && inbox.trim() !== '' ? inbox.trim() : DEFAULT_INBOX;
}

function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v));
  return [String(value)];
}

/** Normalise either a list-view or detail-view API payload into AgentMailMessage. */
export function normalizeMessage(raw: Record<string, unknown>): AgentMailMessage {
  const text =
    typeof raw.text === 'string' && raw.text !== ''
      ? raw.text
      : typeof raw.extracted_text === 'string'
        ? raw.extracted_text
        : '';

  return {
    message_id: String(raw.message_id ?? ''),
    thread_id: raw.thread_id === undefined ? undefined : String(raw.thread_id),
    from: String(raw.from ?? ''),
    to: toArray(raw.to),
    cc: raw.cc === undefined ? undefined : toArray(raw.cc),
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    text,
    preview: typeof raw.preview === 'string' ? raw.preview : undefined,
    timestamp: String(raw.timestamp ?? raw.created_at ?? ''),
    labels: toArray(raw.labels),
    inbox_id: raw.inbox_id === undefined ? undefined : String(raw.inbox_id),
  };
}

/**
 * Extract the bare address from a From header value.
 * "Agent <agent@example.com>" -> "agent@example.com"
 */
export function extractAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  const raw = angle ? angle[1] : value;
  return raw.trim().toLowerCase();
}

/**
 * True when a message originated from this system and must not be re-ingested.
 * Three independent signals — any one is enough (directive 8.3).
 */
export function isLoopback(msg: AgentMailMessage, ownInbox: string): boolean {
  const labels = msg.labels.map(l => l.toLowerCase());
  if (labels.includes(SENT_LABEL)) return true;
  if (labels.includes(OUTBOUND_LABEL.toLowerCase())) return true;
  if (msg.from && extractAddress(msg.from) === ownInbox.trim().toLowerCase()) return true;
  return false;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class AgentMailClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchImpl;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;
  readonly inbox: string;

  constructor(options: AgentMailClientOptions = {}) {
    this.apiKey = options.apiKey ?? requireApiKey();
    this.inbox = options.inbox ?? resolveInbox();
    this.apiBase = (
      options.apiBase ??
      process.env.AGENTMAIL_API_BASE ??
      DEFAULT_API_BASE
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private inboxPath(suffix = ''): string {
    return `${this.apiBase}/inboxes/${encodeURIComponent(this.inbox)}/messages${suffix}`;
  }

  /**
   * Perform a request with timeout + bounded exponential-backoff retry.
   * Never returns a partial success: on exhaustion it throws.
   */
  private async request<T>(
    url: string,
    init: { method?: string; body?: string } = {},
    context = 'request'
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }

      let res: Awaited<ReturnType<FetchImpl>>;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: init.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Network error / timeout — retryable.
        const msg = e instanceof Error ? e.message : String(e);
        lastError = new AgentMailError(
          scrubSecret(`${context}: network error: ${msg}`, this.apiKey)
        );
        continue;
      }

      if (res.ok) {
        const raw = await res.text();
        if (raw.trim() === '') return {} as T;
        try {
          return JSON.parse(raw) as T;
        } catch {
          throw new AgentMailError(
            scrubSecret(`${context}: could not parse JSON response`, this.apiKey)
          );
        }
      }

      const bodyText = await res.text().catch(() => '');
      const detail = scrubSecret(bodyText.slice(0, 300), this.apiKey);
      const err = new AgentMailError(
        `${context}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
        res.status
      );

      if (!isRetryableStatus(res.status)) throw err;
      lastError = err;
    }

    throw lastError ??
      new AgentMailError(`${context}: failed after ${this.maxRetries + 1} attempts`);
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.pageToken) params.set('page_token', options.pageToken);
    if (options.after) params.set('after', options.after);
    if (options.before) params.set('before', options.before);
    if (options.ascending !== undefined) params.set('ascending', String(options.ascending));
    for (const label of options.labels ?? []) params.append('labels', label);

    const qs = params.toString();
    const payload = await this.request<Record<string, unknown>>(
      this.inboxPath(qs ? `?${qs}` : ''),
      {},
      'listMessages'
    );

    const rawMessages = Array.isArray(payload.messages)
      ? (payload.messages as Record<string, unknown>[])
      : [];

    return {
      count: typeof payload.count === 'number' ? payload.count : rawMessages.length,
      messages: rawMessages.map(normalizeMessage),
      next_page_token:
        typeof payload.next_page_token === 'string' && payload.next_page_token !== ''
          ? payload.next_page_token
          : undefined,
    };
  }

  async getMessage(messageId: string): Promise<AgentMailMessage> {
    const payload = await this.request<Record<string, unknown>>(
      this.inboxPath(`/${encodeURIComponent(messageId)}`),
      {},
      'getMessage'
    );
    return normalizeMessage(payload);
  }

  /**
   * Send a message. Always stamps the outbound label + header so that a reply
   * or bounce landing back in this inbox is recognised as loopback.
   *
   * Callers are responsible for enforcing human confirmation; this method is
   * pure transport (the gate lives in commands/mail.ts so it is unbypassable
   * from the CLI surface).
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const labels = Array.from(new Set([...(input.labels ?? []), OUTBOUND_LABEL]));
    const body = JSON.stringify({
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.body,
      labels,
      headers: {
        ...(input.headers ?? {}),
        [OUTBOUND_HEADER]: OUTBOUND_HEADER_VALUE,
      },
    });

    const payload = await this.request<Record<string, unknown>>(
      this.inboxPath('/send'),
      { method: 'POST', body },
      'sendMessage'
    );

    return {
      message_id: String(payload.message_id ?? ''),
      thread_id: String(payload.thread_id ?? ''),
    };
  }
}
