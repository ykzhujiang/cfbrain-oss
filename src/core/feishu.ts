/**
 * Feishu (Lark) client wrapper.
 * Shells out to `lark-cli` for all Feishu API operations.
 * lark-cli must be installed and authenticated before use.
 * Check availability with isLarkCliAvailable() before calling other functions.
 */

/**
 * Path to the lark-cli binary.
 * Defaults to `lark-cli` resolved from PATH, so it works on any platform
 * and any install location (Homebrew, npm, manual). Override with LARK_CLI_BIN
 * if the binary is not on PATH.
 */
const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';

export class LarkCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly args: string[],
  ) {
    super(message);
    this.name = 'LarkCliError';
  }
}

/**
 * Core helper: run lark-cli with the given args, return stdout as string.
 * Throws LarkCliError on non-zero exit.
 */
export async function runLarkCli(args: string[], options?: { cwd?: string }): Promise<string> {
  const proc = Bun.spawn([LARK_CLI_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
    env: { ...process.env, HOME: process.env.LARK_CLI_HOME || process.env.REAL_HOME || process.env.HOME || '' },
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });

  const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const errMsg = stderrBuf.trim() || stdoutBuf.trim() || `lark-cli exited with code ${exitCode}`;
    throw new LarkCliError(
      `lark-cli ${args.join(' ')} failed (exit ${exitCode}): ${errMsg}`,
      exitCode,
      stderrBuf,
      args,
    );
  }

  return stdoutBuf;
}

/**
 * Parse JSON output from lark-cli, stripping any leading/trailing non-JSON text.
 * lark-cli may emit ANSI codes or status lines before the JSON payload.
 */
function parseJsonOutput<T>(raw: string, context: string): T {
  // Try direct parse first
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Find the first '{' or '[' and try parsing from there
    const jsonStart = trimmed.search(/[\[{]/);
    if (jsonStart !== -1) {
      try {
        return JSON.parse(trimmed.slice(jsonStart)) as T;
      } catch {
        // fall through
      }
    }
    throw new Error(`${context}: could not parse JSON output:\n${raw}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether lark-cli is available in PATH.
 * Returns true if found, false otherwise.
 */
export async function isLarkCliAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn([LARK_CLI_BIN, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    // spawn throws if the binary is not found
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wiki node validation
// ---------------------------------------------------------------------------

/**
 * Validate that a Feishu wiki node actually exists and is accessible.
 * Returns true if the node is reachable, false if it returns 404 or any error.
 * Used to detect stale feishu_sync records that point to deleted nodes.
 */
export async function feishuValidateNode(
  spaceId: string,
  nodeToken: string,
): Promise<boolean> {
  try {
    const raw = await runLarkCli([
      'api', 'GET',
      `/open-apis/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}`,
    ]);
    const parsed = parseJsonOutput<{ code?: number }>(raw, 'feishuValidateNode');
    return (parsed.code === 0);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wiki node operations
// ---------------------------------------------------------------------------

interface CreateNodeResponse {
  data?: {
    node?: {
      node_token?: string;
      obj_token?: string;
    };
    node_token?: string;
    obj_token?: string;
  };
  node_token?: string;
  obj_token?: string;
}

/**
 * Create a wiki node under a parent.
 * Runs: lark-cli wiki +node-create --space-id <spaceId> --parent-token <parentToken> --title <title> [--node-type <nodeType>]
 */
export async function feishuCreateNode(
  spaceId: string,
  parentToken: string,
  title: string,
  nodeType: string = 'origin',
  originNodeToken?: string,
): Promise<{ node_token: string; obj_token: string }> {
  const args = [
    'wiki',
    '+node-create',
    '--space-id', spaceId,
    '--title', title,
  ];
  if (parentToken) {
    args.push('--parent-node-token', parentToken);
  }
  if (nodeType === 'shortcut') {
    args.push('--node-type', 'shortcut');
    if (originNodeToken) {
      args.push('--origin-node-token', originNodeToken);
    }
  }

  const raw = await runLarkCli(args);
  const parsed = parseJsonOutput<CreateNodeResponse>(raw, 'feishuCreateNode');

  // Normalize various response shapes lark-cli might return
  const nodeToken =
    parsed.data?.node?.node_token ??
    parsed.data?.node_token ??
    parsed.node_token;

  const objToken =
    parsed.data?.node?.obj_token ??
    parsed.data?.obj_token ??
    parsed.obj_token;

  if (!nodeToken || !objToken) {
    throw new Error(
      `feishuCreateNode: missing node_token or obj_token in response: ${raw}`,
    );
  }

  return { node_token: nodeToken, obj_token: objToken };
}

// ---------------------------------------------------------------------------

interface CreateSpaceResponse {
  data?: {
    space?: { space_id?: string; name?: string };
    space_id?: string;
  };
  space?: { space_id?: string; name?: string };
  space_id?: string;
}

/**
 * Create a new Feishu wiki space and return its id.
 *
 * Saves the user from having to create a space in the Feishu UI and then hunt
 * for its id in the URL. Runs: lark-cli wiki +space-create --name <name>
 */
export async function feishuCreateSpace(
  name: string,
  description?: string,
): Promise<{ space_id: string }> {
  // Creating a wiki space is a user-only operation — the API rejects a bot
  // identity ("this command only supports: user"), so pin --as user explicitly
  // rather than relying on lark-cli's auto-detected default.
  const args = ['wiki', '+space-create', '--as', 'user', '--name', name];
  if (description) args.push('--description', description);

  const raw = await runLarkCli(args);
  const parsed = parseJsonOutput<CreateSpaceResponse>(raw, 'feishuCreateSpace');

  const spaceId =
    parsed.data?.space?.space_id ??
    parsed.data?.space_id ??
    parsed.space?.space_id ??
    parsed.space_id;

  if (!spaceId) {
    throw new Error(`feishuCreateSpace: missing space_id in response: ${raw}`);
  }

  return { space_id: spaceId };
}

// ---------------------------------------------------------------------------

interface ListNodesResponse {
  data?: {
    items?: NodeItem[];
    nodes?: NodeItem[];
  };
  items?: NodeItem[];
  nodes?: NodeItem[];
}

interface NodeItem {
  node_token?: string;
  title?: string;
  obj_token?: string;
  node_type?: string | number;
  parent_node_token?: string;
}

/**
 * List all nodes in a wiki space.
 * Runs: lark-cli wiki nodes list --space-id <spaceId> --output json
 */
export async function feishuListNodes(
  spaceId: string,
): Promise<Array<{ node_token: string; title: string; obj_token: string; node_type: string; parent_node_token: string }>> {
  const args = [
    'wiki',
    'nodes',
    'list',
    '--params', JSON.stringify({ space_id: spaceId }),
    '--page-all',
    '--format', 'json',
  ];

  const raw = await runLarkCli(args);
  const parsed = parseJsonOutput<ListNodesResponse>(raw, 'feishuListNodes');

  const items: NodeItem[] =
    parsed.data?.items ??
    parsed.data?.nodes ??
    parsed.items ??
    parsed.nodes ??
    [];

  return items.map((item) => ({
    node_token: item.node_token ?? '',
    title: item.title ?? '',
    obj_token: item.obj_token ?? '',
    node_type: String(item.node_type ?? 'doc'),
    parent_node_token: item.parent_node_token ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Duplicate prevention: check if a child node with a given title already exists
// ---------------------------------------------------------------------------

/**
 * Check if a node with the given title already exists under a parent node.
 * Uses a pre-built cache (or fetches all nodes if no cache provided).
 * Returns the existing node's tokens if found, null otherwise.
 */
export async function findExistingChildByTitle(
  spaceId: string,
  parentNodeToken: string,
  title: string,
  _allNodes?: Array<{ node_token: string; title: string; obj_token: string; node_type: string; parent_node_token: string }>,
): Promise<{ node_token: string; obj_token: string } | null> {
  // Query children of the specific parent directory (not root-level nodes)
  try {
    const raw = await runLarkCli([
      'wiki', 'nodes', 'list',
      '--params', JSON.stringify({ space_id: spaceId, parent_node_token: parentNodeToken }),
      '--format', 'json',
    ]);
    const parsed = parseJsonOutput<ListNodesResponse>(raw, 'findExistingChildByTitle');
    const items: NodeItem[] = parsed.data?.items ?? parsed.data?.nodes ?? parsed.items ?? parsed.nodes ?? [];
    const match = items.find((n) => (n.title ?? '') === title);
    return match ? { node_token: match.node_token ?? '', obj_token: match.obj_token ?? '' } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------

/**
 * Overwrite a Feishu doc's content with Markdown.
 * Runs: lark-cli docs +update --obj-token <objToken> --mode overwrite --content <markdown>
 *
 * Content is passed via stdin to avoid shell-quoting issues with large payloads.
 */
export async function feishuUpdateDoc(objToken: string, markdown: string): Promise<void> {
  // Write markdown to a temp file to avoid argument-length / quoting issues
  const tmpName = `.feishu-update-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  const tmp = tmpName;
  await Bun.write(tmp, markdown);

  try {
    const args = [
      'docs',
      '+update',
      '--doc', objToken,
      '--mode', 'overwrite',
      '--markdown', `@${tmpName}`,
    ];
    await runLarkCli(args);
  } finally {
    // Best-effort cleanup
    try {
      const { unlink } = await import('fs/promises');
      await unlink(tmp);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Fetch the Markdown content of a Feishu doc.
 * Runs: lark-cli docs +fetch --obj-token <objToken>
 * Returns the raw Markdown string.
 */
export async function feishuFetchDoc(objToken: string): Promise<string> {
  const args = [
    'docs',
    '+fetch',
    '--doc', objToken,
  ];

  const raw = await runLarkCli(args);

  // lark-cli may return raw Markdown or a JSON envelope; handle both.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as { data?: { content?: string }; content?: string };
      const content = parsed.data?.content ?? parsed.content;
      if (content !== undefined) return content;
    } catch {
      // Not JSON — treat as raw Markdown
    }
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

interface BotInfoResponse {
  bot?: { open_id?: string; app_name?: string };
  data?: { bot?: { open_id?: string; app_name?: string } };
}

let _cachedBotOpenId: string | null = null;

/**
 * Get the bot's open_id by calling the Feishu Bot Info API.
 * Result is cached for the lifetime of the process.
 */
export async function feishuGetBotOpenId(): Promise<string> {
  if (_cachedBotOpenId) return _cachedBotOpenId;

  const raw = await runLarkCli(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot']);
  const parsed = parseJsonOutput<BotInfoResponse>(raw, 'feishuGetBotOpenId');
  const openId = parsed.data?.bot?.open_id ?? parsed.bot?.open_id ?? '';
  if (!openId) {
    throw new LarkCliError(
      'Could not determine bot open_id from /open-apis/bot/v3/info',
      null,
      '',
      ['api', 'GET', '/open-apis/bot/v3/info'],
    );
  }
  _cachedBotOpenId = openId;
  return openId;
}

/** Reset cached bot open_id (for testing). */
export function _resetBotOpenIdCache(): void {
  _cachedBotOpenId = null;
}

// ---------------------------------------------------------------------------
// Comment operations
// ---------------------------------------------------------------------------

interface CommentListResponse {
  data?: {
    items?: CommentItem[];
  };
  items?: CommentItem[];
}

interface CommentElement {
  text_run?: {
    content?: string;
    text?: string;
    link?: { url?: string };
  };
  mention_user?: { user_id?: string; open_id?: string };
  person?: { user_id?: string; open_id?: string };
  link?: { url?: string };
  docs_link?: { url?: string };
  type?: string;
}

interface CommentItem {
  comment_id?: string;
  content?: string;
  user_id?: string;
  // Depending on lark-cli version, comment body may be nested
  reply_list?: {
    replies?: Array<{
      user_id?: string;
      content?: { elements?: CommentElement[] };
    }>;
  };
  quote?: string;
  is_solved?: boolean;
  solved?: boolean;
}

/**
 * Extract display text from a Feishu comment element, preserving link URLs.
 * - text_run with link → "display text (URL)"
 * - text_run without link → plain text
 * - standalone link / docs_link → URL
 * - other element types → empty string
 */
export function extractElementText(el: CommentElement): string {
  if (el.text_run) {
    const text = el.text_run.text ?? el.text_run.content ?? '';
    const url = el.text_run.link?.url;
    if (url) {
      return text ? `${text} (${url})` : url;
    }
    return text;
  }
  if (el.type === 'link' || el.type === 'docs_link') {
    return el.link?.url ?? el.docs_link?.url ?? '';
  }
  if (el.link?.url) return el.link.url;
  if (el.docs_link?.url) return el.docs_link.url;
  return '';
}

/**
 * List comments on a Feishu drive file.
 * Runs: lark-cli drive file.comments list --file-token <objToken> --output json
 */
export async function feishuListComments(
  objToken: string,
): Promise<Array<{ comment_id: string; content: string; quote: string; is_solved: boolean; commenter: string; mention_open_ids: string[] }>> {
  const args = [
    'drive',
    'file.comments',
    'list',
    '--params', JSON.stringify({ file_token: objToken, file_type: 'docx' }),
    '--format', 'json',
  ];

  const raw = await runLarkCli(args);
  const parsed = parseJsonOutput<CommentListResponse>(raw, 'feishuListComments');

  const items: CommentItem[] =
    parsed.data?.items ??
    parsed.items ??
    [];

  return items.map((item) => {
    // Extract plain-text content and @mention open_ids from potentially nested reply_list structure
    let content = item.content ?? '';
    let commenter = item.user_id ?? '';
    const mentionOpenIds: string[] = [];

    if (item.reply_list?.replies?.length) {
      // Scan ALL replies for @mentions (not just the first one)
      for (const reply of item.reply_list.replies) {
        const elements = reply?.content?.elements ?? [];
        for (const el of elements) {
          const mentionId = el.mention_user?.open_id ?? el.mention_user?.user_id ?? el.person?.user_id ?? el.person?.open_id;
          if (mentionId) mentionOpenIds.push(mentionId);
        }
      }

      if (!content) {
        const firstReply = item.reply_list.replies[0];
        const elements = firstReply?.content?.elements ?? [];
        content = elements
          .map((el) => extractElementText(el))
          .join('');
        if (!commenter && firstReply?.user_id) {
          commenter = firstReply.user_id;
        }
      }
    }

    return {
      comment_id: item.comment_id ?? '',
      content,
      quote: item.quote ?? '',
      is_solved: item.is_solved ?? item.solved ?? false,
      commenter,
      mention_open_ids: mentionOpenIds,
    };
  });
}

// ---------------------------------------------------------------------------

/**
 * Reply to an existing comment on a Feishu drive file.
 * Runs: lark-cli drive file.comment.replys create --file-token <fileToken> --comment-id <commentId> --content <content>
 */
export async function feishuReplyComment(
  fileToken: string,
  commentId: string,
  content: string,
): Promise<void> {
  const args = [
    'drive',
    'file.comment.replys',
    'create',
    '--as', 'bot',
    '--params', JSON.stringify({ file_token: fileToken, comment_id: commentId, file_type: 'docx' }),
    '--data', JSON.stringify({ content: { elements: [{ type: 'text_run', text_run: { text: content } }] } }),
  ];

  await runLarkCli(args);
}

// ---------------------------------------------------------------------------

/**
 * Mark a comment as resolved on a Feishu drive file.
 * Runs: lark-cli drive file.comments patch --file-token <fileToken> --comment-id <commentId> --is-solved true
 */
export async function feishuResolveComment(
  fileToken: string,
  commentId: string,
): Promise<void> {
  const args = [
    'drive',
    'file.comments',
    'patch',
    '--params', JSON.stringify({ file_token: fileToken, comment_id: commentId, file_type: 'docx' }),
    '--data', JSON.stringify({ is_solved: true }),
  ];

  await runLarkCli(args);
}

// ---------------------------------------------------------------------------
// Node move operation (for trash directory support)
// ---------------------------------------------------------------------------

/**
 * Move a wiki node to a different parent (e.g., trash directory).
 * Runs: lark-cli api POST /open-apis/wiki/v2/spaces/{spaceId}/nodes/{nodeToken}/move
 *   --data '{"target_parent_token":"<targetParentToken>"}'
 */
export async function feishuMoveNode(
  spaceId: string,
  nodeToken: string,
  targetParentToken: string,
): Promise<void> {
  const args = [
    'api',
    'POST',
    `/open-apis/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}/move`,
    '--data', JSON.stringify({ target_parent_token: targetParentToken }),
  ];

  await runLarkCli(args);
}

// ---------------------------------------------------------------------------
// Node rename operation (for title propagation on re-push)
// ---------------------------------------------------------------------------

/**
 * Rename a wiki node's title in the sidebar/breadcrumb.
 * Uses POST /open-apis/wiki/v2/spaces/{spaceId}/nodes/{nodeToken}/update_title
 * (the old PUT endpoint returned 404 — Spec 38 R1 fix).
 */
export async function feishuRenameNode(
  spaceId: string,
  nodeToken: string,
  newTitle: string,
): Promise<void> {
  const args = [
    'api',
    'POST',
    `/open-apis/wiki/v2/spaces/${spaceId}/nodes/${nodeToken}/update_title`,
    '--data', JSON.stringify({ title: newTitle }),
  ];

  await runLarkCli(args);
}

/**
 * Update the document title block (Page block, block_type=1).
 * The Page block's block_id equals the document_id (objToken).
 * Uses PATCH /open-apis/docx/v1/documents/{id}/blocks/{id} with update_text_elements.
 * (Spec 38 R2)
 */
export async function feishuUpdateDocTitle(
  objToken: string,
  newTitle: string,
): Promise<void> {
  const args = [
    'api',
    'PATCH',
    `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}`,
    '--data', JSON.stringify({
      update_text_elements: {
        elements: [
          { text_run: { content: newTitle } },
        ],
      },
    }),
    '--params', JSON.stringify({ document_revision_id: -1 }),
  ];

  await runLarkCli(args);
}

// ---------------------------------------------------------------------------
// Feishu-specific serialization (no frontmatter)
// ---------------------------------------------------------------------------

/**
 * Serialize a brain page for Feishu display.
 * Unlike serializeMarkdown(), this outputs ONLY the content body:
 *   - compiled_truth (the main knowledge content)
 * No YAML frontmatter, no types/tags/title metadata in body.
 */
export function serializeForFeishu(
  compiled_truth: string,
  title?: string,
): string {
  if (!title) return compiled_truth;
  // Spec 39 + fix: strip leading H1 if it fuzzy-matches the page title
  const lines = compiled_truth.split('\n');
  const firstLine = lines[0] ?? '';
  const h1Match = firstLine.match(/^#\s+(.+)/);
  if (h1Match && h1TitleMatches(h1Match[1], title)) {
    // Remove the H1 line and any immediately following blank line
    let start = 1;
    if (lines[start] === '') start++;
    return lines.slice(start).join('\n');
  }
  return compiled_truth;
}

/**
 * Fuzzy match H1 text against page title.
 * Returns true if: exact match (case-insensitive), one is prefix of the other,
 * or Levenshtein similarity >80%.
 */
export function h1TitleMatches(h1Text: string, title: string): boolean {
  const a = h1Text.trim().toLowerCase();
  const b = title.trim().toLowerCase();
  if (!a || !b) return false;
  // Exact match
  if (a === b) return true;
  // Prefix match (either direction)
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // Levenshtein similarity >80%
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return false;
  const dist = levenshteinDistance(a, b);
  const similarity = 1 - dist / maxLen;
  return similarity > 0.8;
}

/** Simple Levenshtein distance (O(n*m) DP). */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use single-row optimization
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,       // insertion
        prev[j]! + 1,           // deletion
        prev[j - 1]! + cost,    // substitution
      );
    }
    prev = curr;
  }
  return prev[n]!;
}

// ---------------------------------------------------------------------------
// Wiki-link conversion (markdown mode — kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Convert [[wiki-links]] in markdown to Feishu document URLs.
 * feishuSyncMap: slug → obj_token mapping from feishu_sync table.
 * Unresolved links are left as-is with a [?] marker appended.
 *
 * NOTE: This produces markdown links [text](url) which may not render as
 * clickable hyperlinks in Feishu. For proper hyperlinks, use
 * convertMarkdownToBlocks() which uses the Feishu block API format.
 */
export function convertWikiLinks(
  markdown: string,
  feishuSyncMap: Map<string, string>,
): string {
  return markdown.replace(/\[\[([^\]]+)\]\]/g, (_match, slug: string) => {
    const objToken = feishuSyncMap.get(slug);
    if (objToken) {
      return `[${slug}](https://feishu.cn/docx/${objToken})`;
    }
    return `[[${slug}]][?]`;
  });
}

// ---------------------------------------------------------------------------
// Feishu Block API — Spec 11: clickable hyperlinks
// ---------------------------------------------------------------------------

/** Feishu DocX block type constants */
const BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  HEADING4: 6,
  HEADING5: 7,
  HEADING6: 8,
  HEADING7: 9,
  HEADING8: 10,
  HEADING9: 11,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  DIVIDER: 22,
} as const;

/** A text_run element in a Feishu block */
export interface FeishuTextElement {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      inline_code?: boolean;
      link?: { url: string };
    };
  };
}

/** A Feishu document block (paragraph, heading, list item, etc.) */
export interface FeishuBlock {
  block_type: number;
  [key: string]: unknown; // heading1, heading2, text, bullet, ordered, code, divider
}

/**
 * Parse inline markdown formatting into Feishu text_run elements.
 * Handles: [[wiki-links]], [text](url), **bold**, *italic*, `code`, plain text.
 */
export function parseInlineElements(
  text: string,
  feishuSyncMap: Map<string, string>,
): FeishuTextElement[] {
  const elements: FeishuTextElement[] = [];
  // Order matters: wiki-links before markdown links, bold before italic
  const INLINE_RE = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      elements.push({
        text_run: { content: text.slice(lastIndex, match.index), text_element_style: {} },
      });
    }

    if (match[1] !== undefined) {
      // [[wiki-link]]
      const slug = match[1];
      const objToken = feishuSyncMap.get(slug);
      if (objToken) {
        elements.push({
          text_run: {
            content: slug,
            text_element_style: { link: { url: `https://feishu.cn/docx/${objToken}` } },
          },
        });
      } else {
        elements.push({
          text_run: { content: `${slug}[?]`, text_element_style: {} },
        });
      }
    } else if (match[2] !== undefined) {
      // [text](url)
      elements.push({
        text_run: {
          content: match[2],
          text_element_style: { link: { url: match[3] } },
        },
      });
    } else if (match[4] !== undefined) {
      // **bold**
      elements.push({
        text_run: { content: match[4], text_element_style: { bold: true } },
      });
    } else if (match[5] !== undefined) {
      // *italic*
      elements.push({
        text_run: { content: match[5], text_element_style: { italic: true } },
      });
    } else if (match[6] !== undefined) {
      // `code`
      elements.push({
        text_run: { content: match[6], text_element_style: { inline_code: true } },
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    elements.push({
      text_run: { content: text.slice(lastIndex), text_element_style: {} },
    });
  }

  // Ensure at least one element (Feishu requires non-empty elements array)
  if (elements.length === 0) {
    elements.push({
      text_run: { content: text || ' ', text_element_style: {} },
    });
  }

  return elements;
}

/**
 * Convert markdown content to Feishu block API format.
 * Wiki-links [[slug]] become text_run elements with clickable hyperlinks (Spec 11 R1/R3).
 * Unresolved links become plain text with [?] marker (Spec 11 R4).
 */
export function convertMarkdownToBlocks(
  markdown: string,
  feishuSyncMap: Map<string, string>,
): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({
        block_type: BLOCK_TYPE.CODE,
        code: {
          elements: [{ text_run: { content: codeLines.join('\n'), text_element_style: {} } }],
          style: { language: 1 }, // 1 = PlainText
        },
      });
      continue;
    }

    // Heading (# through ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const elements = parseInlineElements(headingMatch[2], feishuSyncMap);
      const blockType = BLOCK_TYPE.HEADING1 + level - 1;
      blocks.push({
        block_type: blockType,
        [`heading${level}`]: { elements },
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$|^\*{3,}$/.test(line.trim())) {
      blocks.push({ block_type: BLOCK_TYPE.DIVIDER, divider: {} });
      i++;
      continue;
    }

    // Bullet list item (-, *, +)
    const bulletMatch = line.match(/^[\s]*[-*+]\s+(.+)/);
    if (bulletMatch) {
      blocks.push({
        block_type: BLOCK_TYPE.BULLET,
        bullet: { elements: parseInlineElements(bulletMatch[1], feishuSyncMap) },
      });
      i++;
      continue;
    }

    // Ordered list item (1. 2. etc.)
    const orderedMatch = line.match(/^[\s]*\d+\.\s+(.+)/);
    if (orderedMatch) {
      blocks.push({
        block_type: BLOCK_TYPE.ORDERED,
        ordered: { elements: parseInlineElements(orderedMatch[1], feishuSyncMap) },
      });
      i++;
      continue;
    }

    // Regular paragraph
    blocks.push({
      block_type: BLOCK_TYPE.TEXT,
      text: { elements: parseInlineElements(line, feishuSyncMap) },
    });
    i++;
  }

  return blocks;
}

/**
 * Replace all content in a Feishu document using the block API.
 * This creates proper clickable hyperlinks (unlike markdown mode).
 *
 * Flow: list children → batch delete → batch create new blocks.
 * Uses lark-cli api for raw Feishu API calls.
 */
export async function feishuUpdateDocBlocks(
  objToken: string,
  blocks: FeishuBlock[],
  _fallbackMarkdown?: string,
): Promise<void> {
  // Helper: list current children count
  async function listChildCount(): Promise<number> {
    try {
      const listRaw = await runLarkCli([
        'api', 'GET',
        `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children`,
        '--params', JSON.stringify({ document_revision_id: -1 }),
      ]);
      const listResp = parseJsonOutput<{
        data?: { children?: unknown[]; items?: unknown[] };
      }>(listRaw, 'feishuUpdateDocBlocks:listChildren');
      return (listResp.data?.children ?? listResp.data?.items ?? []).length;
    } catch {
      return 0; // If listing fails, doc may be newly created/empty
    }
  }

  // Step 1: List current children to know how many to delete
  let childCount = await listChildCount();

  // Step 2: Delete all existing children with document_revision_id=-1 (Spec 24 R2)
  // On failure, re-list and retry once with fresh child count (Spec 24 R3: retry instead of degrade)
  if (childCount > 0) {
    try {
      await runLarkCli([
        'api', 'DELETE',
        `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children/batch_delete`,
        '--data', JSON.stringify({ start_index: 0, end_index: childCount, document_revision_id: -1 }),
      ]);
    } catch (batchDeleteErr) {
      // Spec 24 R3: retry with fresh child list instead of degrading to plain markdown
      const msg = batchDeleteErr instanceof Error ? batchDeleteErr.message : String(batchDeleteErr);
      console.warn(`  WARN  batch_delete failed (${msg}), re-listing children and retrying...`);

      childCount = await listChildCount();
      if (childCount > 0) {
        try {
          await runLarkCli([
            'api', 'DELETE',
            `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children/batch_delete`,
            '--data', JSON.stringify({ start_index: 0, end_index: childCount, document_revision_id: -1 }),
          ]);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new LarkCliError(`batch_delete failed after retry: initial: ${msg}; retry: ${retryMsg}`, null, '', []);
        }
      }
    }
  }

  // Step 3: Create new blocks (Feishu allows up to 50 blocks per request)
  // Only reached if batch_delete succeeded (or childCount was 0)
  const BATCH_SIZE = 50;
  for (let start = 0; start < blocks.length; start += BATCH_SIZE) {
    const batch = blocks.slice(start, start + BATCH_SIZE);
    await runLarkCli([
      'api', 'POST',
      `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children`,
      '--data', JSON.stringify({ children: batch, index: start }),
    ]);
  }
}

/**
 * Insert a file into a Feishu document as an inline image or clickable file block.
 * Uses lark-cli docs +media-insert which handles the full
 * 4-step orchestration (create block → upload → patch → verify).
 * Note: lark-cli requires relative file paths for security, so we cd to the file's directory.
 * @param mediaType 'image' for inline rendering, 'file' for downloadable attachment
 * Returns true on success, false on failure.
 */
export async function feishuInsertFile(docToken: string, filePath: string, mediaType: 'image' | 'file' = 'file'): Promise<boolean> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
    await runLarkCli([
      'docs', '+media-insert', '--doc', docToken, '--file', `./${fileName}`, '--type', mediaType,
    ], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Feishu blocks for the "📎 原始文件" attachment section.
 * Returns a divider + heading + text block with a file link for each raw source.
 */
export function buildAttachmentBlocks(
  rawSources: string[],
  fileTokenMap: Map<string, string>,
): FeishuBlock[] {
  if (rawSources.length === 0) return [];

  const blocks: FeishuBlock[] = [];

  // Divider
  blocks.push({ block_type: BLOCK_TYPE.DIVIDER, divider: {} });

  // Heading: 📎 原始文件
  blocks.push({
    block_type: BLOCK_TYPE.HEADING2,
    heading2: {
      elements: [{ text_run: { content: '📎 原始文件' } }],
    },
  });

  // One text line per raw source file
  for (const rawSource of rawSources) {
    const fileName = rawSource.split('/').pop() || rawSource;
    const fileToken = fileTokenMap.get(rawSource);

    if (fileToken) {
      // File block (block_type 23 = FILE in Feishu DocX API)
      blocks.push({
        block_type: 23, // FILE
        file: { token: fileToken },
      });
    } else {
      // Fallback: plain text with filename
      blocks.push({
        block_type: BLOCK_TYPE.TEXT,
        text: {
          elements: [{ text_run: { content: `📄 ${fileName}` } }],
        },
      });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Spec 48: Attachment section detection
// ---------------------------------------------------------------------------

/**
 * Find the start index of the "📎 原始素材" attachment section in document blocks.
 * Returns the index of the divider immediately before the heading (if present),
 * or the heading index itself. Returns -1 if no attachment section found.
 */
export function findAttachmentSectionStart(blocks: FeishuDocBlock[]): number {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.block_type === BLOCK_TYPE.HEADING2) {
      const heading = block.heading2 as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
      const text = heading?.elements?.map(el => el.text_run?.content ?? '').join('') ?? '';
      if (text.includes('📎 原始素材') || text.includes('📎 原始文件')) {
        if (i > 0 && blocks[i - 1].block_type === BLOCK_TYPE.DIVIDER) {
          return i - 1;
        }
        return i;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Spec 37: Incremental document update — preserve comments on push
// ---------------------------------------------------------------------------

/** A document block as returned by the Feishu API (includes block_id). */
export interface FeishuDocBlock {
  block_id: string;
  block_type: number;
  [key: string]: unknown;
}

/**
 * Fetch current document blocks with their content and block IDs.
 * Uses GET /docx/v1/documents/{id}/blocks/{id}/children.
 */
export async function feishuFetchDocBlocks(objToken: string): Promise<FeishuDocBlock[]> {
  try {
    const raw = await runLarkCli([
      'api', 'GET',
      `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children`,
      '--params', JSON.stringify({ document_revision_id: -1 }),
    ]);
    const resp = parseJsonOutput<{
      data?: { children?: FeishuDocBlock[]; items?: FeishuDocBlock[] };
    }>(raw, 'feishuFetchDocBlocks');
    return resp.data?.children ?? resp.data?.items ?? [];
  } catch {
    return [];
  }
}

/**
 * Extract a text fingerprint from a block for comparison.
 * Concatenates all text_run content values, prefixed by block_type for type-aware matching.
 */
export function extractBlockText(block: FeishuDocBlock | FeishuBlock): string {
  const bt = block.block_type;

  // Divider has no text content — use a sentinel
  if (bt === BLOCK_TYPE.DIVIDER) return '\x00DIVIDER';

  // Find the content field (text, heading1-9, bullet, ordered, code)
  const contentKeys = [
    'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5',
    'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'code',
  ];

  for (const key of contentKeys) {
    const content = block[key] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
    if (content?.elements) {
      const text = content.elements
        .map((el) => el.text_run?.content ?? '')
        .join('');
      return `${bt}:${text}`;
    }
  }

  return `${bt}:`;
}

/**
 * Compute the longest common subsequence of two string arrays.
 * Returns matched index pairs: [oldIdx, newIdx][].
 */
export function lcsBlocks(oldTexts: string[], newTexts: string[]): [number, number][] {
  const m = oldTexts.length;
  const n = newTexts.length;
  if (m === 0 || n === 0) return [];

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTexts[i - 1] === newTexts[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matched pairs
  const matches: [number, number][] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldTexts[i - 1] === newTexts[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches.reverse();
}

/**
 * Diff result: how many blocks are kept vs changed, and the gap operations.
 */
export interface IncrementalDiffResult {
  /** Fraction of blocks that changed (0.0 = identical, 1.0 = completely different) */
  changeRatio: number;
  /** Number of blocks kept unchanged */
  kept: number;
  /** Gaps between kept blocks that need delete + insert operations */
  gaps: Array<{
    /** Start index in old doc to delete from (inclusive) */
    deleteStart: number;
    /** End index in old doc to delete to (exclusive) */
    deleteEnd: number;
    /** New blocks to insert at this position */
    insertBlocks: FeishuBlock[];
  }>;
}

/**
 * Diff old document blocks vs new blocks.
 * Returns change ratio and gap operations for incremental update.
 */
export function diffDocBlocks(
  oldBlocks: FeishuDocBlock[],
  newBlocks: FeishuBlock[],
): IncrementalDiffResult {
  const oldTexts = oldBlocks.map(extractBlockText);
  const newTexts = newBlocks.map(extractBlockText);

  const matches = lcsBlocks(oldTexts, newTexts);
  const kept = matches.length;
  const totalBlocks = Math.max(oldBlocks.length, newBlocks.length, 1);
  const changed = Math.max(oldBlocks.length - kept, newBlocks.length - kept);
  const changeRatio = changed / totalBlocks;

  // Build gaps between consecutive matches (including before first and after last)
  // Add sentinels: (-1, -1) at start and (oldLen, newLen) at end
  const anchors: [number, number][] = [[-1, -1], ...matches, [oldBlocks.length, newBlocks.length]];
  const gaps: IncrementalDiffResult['gaps'] = [];

  for (let k = 0; k < anchors.length - 1; k++) {
    const [oPrev, nPrev] = anchors[k];
    const [oNext, nNext] = anchors[k + 1];

    const deleteStart = oPrev + 1;
    const deleteEnd = oNext; // exclusive
    const insertStart = nPrev + 1;
    const insertEnd = nNext; // exclusive

    if (deleteStart < deleteEnd || insertStart < insertEnd) {
      gaps.push({
        deleteStart,
        deleteEnd,
        insertBlocks: newBlocks.slice(insertStart, insertEnd),
      });
    }
  }

  return { changeRatio, kept, gaps };
}

/**
 * Incrementally update a Feishu document, preserving unchanged blocks (and their comments).
 * Falls back to full rewrite if >80% of blocks changed or if incremental update fails.
 *
 * @returns Stats about the update operation.
 */
export async function feishuIncrementalUpdateDocBlocks(
  objToken: string,
  newBlocks: FeishuBlock[],
  excludeTailFromIndex?: number,
  prefetchedBlocks?: FeishuDocBlock[],
): Promise<{ incremental: boolean; kept: number; deleted: number; inserted: number }> {
  // Step 1: Fetch current document blocks with content
  const fetchedBlocks = prefetchedBlocks ?? await feishuFetchDocBlocks(objToken);

  // If document is empty, just create all blocks (same as full write)
  if (fetchedBlocks.length === 0) {
    await feishuUpdateDocBlocks(objToken, newBlocks);
    return { incremental: false, kept: 0, deleted: 0, inserted: newBlocks.length };
  }

  // Spec 48: exclude attachment tail from INCR diff
  const hasTail = excludeTailFromIndex !== undefined && excludeTailFromIndex >= 0 && excludeTailFromIndex < fetchedBlocks.length;
  const oldBlocks = hasTail ? fetchedBlocks.slice(0, excludeTailFromIndex) : fetchedBlocks;
  const tailBlockCount = fetchedBlocks.length - oldBlocks.length;

  // Step 2: Diff old vs new
  const diff = diffDocBlocks(oldBlocks, newBlocks);

  // Step 3: Fallback if >80% changed
  if (diff.changeRatio > 0.8) {
    console.log(`  INCR  >80% blocks changed (${(diff.changeRatio * 100).toFixed(0)}%), falling back to full rewrite`);
    await feishuUpdateDocBlocks(objToken, newBlocks);
    return { incremental: false, kept: 0, deleted: fetchedBlocks.length, inserted: newBlocks.length };
  }

  // Step 4: Apply incremental changes — process gaps from RIGHT to LEFT
  let totalDeleted = 0;
  let totalInserted = 0;
  const BATCH_SIZE = 50;

  try {
    for (let g = diff.gaps.length - 1; g >= 0; g--) {
      const gap = diff.gaps[g];

      // Delete old blocks in this gap (if any)
      const delCount = gap.deleteEnd - gap.deleteStart;
      if (delCount > 0) {
        await runLarkCli([
          'api', 'DELETE',
          `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children/batch_delete`,
          '--data', JSON.stringify({
            start_index: gap.deleteStart,
            end_index: gap.deleteEnd,
            document_revision_id: -1,
          }),
        ]);
        totalDeleted += delCount;
      }

      // Insert new blocks at this position (if any)
      if (gap.insertBlocks.length > 0) {
        for (let s = 0; s < gap.insertBlocks.length; s += BATCH_SIZE) {
          const batch = gap.insertBlocks.slice(s, s + BATCH_SIZE);
          await runLarkCli([
            'api', 'POST',
            `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children`,
            '--data', JSON.stringify({
              children: batch,
              index: gap.deleteStart + s,
            }),
          ]);
        }
        totalInserted += gap.insertBlocks.length;
      }
    }

    // Spec 48: delete old attachment tail after INCR content updates
    if (hasTail && tailBlockCount > 0) {
      const tailStart = excludeTailFromIndex + totalInserted - totalDeleted;
      await runLarkCli([
        'api', 'DELETE',
        `/open-apis/docx/v1/documents/${objToken}/blocks/${objToken}/children/batch_delete`,
        '--data', JSON.stringify({
          start_index: tailStart,
          end_index: tailStart + tailBlockCount,
          document_revision_id: -1,
        }),
      ]);
      totalDeleted += tailBlockCount;
    }
  } catch (err) {
    // Incremental update failed — fall back to full rewrite
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  WARN  incremental update failed (${msg}), falling back to full rewrite`);
    await feishuUpdateDocBlocks(objToken, newBlocks);
    return { incremental: false, kept: 0, deleted: fetchedBlocks.length, inserted: newBlocks.length };
  }

  console.log(`  INCR  kept ${diff.kept}, deleted ${totalDeleted}, inserted ${totalInserted} blocks`);
  return { incremental: true, kept: diff.kept, deleted: totalDeleted, inserted: totalInserted };
}
