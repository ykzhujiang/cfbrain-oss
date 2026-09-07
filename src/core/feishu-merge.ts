import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, extname } from 'path';

export interface MergeSubMessage {
  sender: string;
  sender_id: string;
  timestamp: string;
  type: string;
  text: string;
  media_path?: string;
  file_name?: string;
}

export interface MergeForwardResult {
  message_id: string;
  messages: MergeSubMessage[];
  media_files: string[];
  text_summary: string;
}

export interface FetchMergeOptions {
  outputDir?: string;
  maxDepth?: number;
}

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const MAX_FILE_SIZE = 30 * 1024 * 1024;

function getAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      'Missing Feishu app credentials. Set LARK_APP_ID and LARK_APP_SECRET environment variables.\n' +
      'The app needs scopes: im:message:readonly, im:resource, contact:user.base:readonly',
    );
  }
  return { appId, appSecret };
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg} (code ${data.code})`);
  }
  return data.tenant_access_token;
}

async function feishuGet(token: string, path: string): Promise<Response> {
  return fetch(`${FEISHU_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function feishuGetJson(token: string, path: string): Promise<any> {
  const res = await feishuGet(token, path);
  return res.json();
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
  };
  return map[mime] || '.bin';
}

function formatTimestamp(ts: string): string {
  const ms = parseInt(ts);
  if (isNaN(ms)) return ts;
  return new Date(ms).toISOString();
}

interface ExtractedContent {
  text: string;
  resources: Array<{ type: 'image' | 'file'; key: string; fileName?: string }>;
}

function extractContent(msgType: string, content: any): ExtractedContent {
  switch (msgType) {
    case 'text':
      return { text: content?.text || '', resources: [] };

    case 'post': {
      let text = '';
      const resources: ExtractedContent['resources'] = [];
      const title = content?.title || '';
      if (title) text += title + '\n';
      for (const para of content?.content || []) {
        for (const elem of para || []) {
          if (elem.tag === 'text') text += elem.text || '';
          else if (elem.tag === 'a') text += elem.text || elem.href || '';
          else if (elem.tag === 'at') text += `@${elem.user_name || elem.user_id || ''}`;
          else if (elem.tag === 'img' && elem.image_key) {
            text += '[Image]';
            resources.push({ type: 'image', key: elem.image_key });
          }
        }
        text += '\n';
      }
      return { text: text.trim(), resources };
    }

    case 'image':
      return {
        text: '[Image]',
        resources: content?.image_key ? [{ type: 'image', key: content.image_key }] : [],
      };

    case 'file':
      return {
        text: `[File: ${content?.file_name || 'unknown'}]`,
        resources: content?.file_key
          ? [{ type: 'file', key: content.file_key, fileName: content.file_name }]
          : [],
      };

    case 'audio':
      return {
        text: '[Audio]',
        resources: content?.file_key ? [{ type: 'file', key: content.file_key, fileName: 'audio.mp3' }] : [],
      };

    case 'video':
      return {
        text: '[Video]',
        resources: (content?.file_key || content?.video_key)
          ? [{ type: 'file', key: content.file_key || content.video_key, fileName: content.file_name || 'video.mp4' }]
          : [],
      };

    case 'media':
      return {
        text: `[Media: ${content?.file_name || 'unknown'}]`,
        resources: content?.file_key
          ? [{ type: 'file', key: content.file_key, fileName: content.file_name }]
          : [],
      };

    case 'sticker':
      return { text: '[Sticker]', resources: [] };

    case 'share_chat':
      return { text: `[Shared Chat: ${content?.chat_name || ''}]`, resources: [] };

    case 'share_user':
      return { text: `[Shared User: ${content?.user_id || ''}]`, resources: [] };

    default:
      return { text: `[${msgType}]`, resources: [] };
  }
}

async function downloadResource(
  token: string,
  upperMessageId: string,
  resourceKey: string,
  resourceType: 'image' | 'file',
  outputDir: string,
  datePrefix: string,
  typeLabel: string,
  index: number,
  fileName?: string,
): Promise<string | null> {
  const url = `${FEISHU_API_BASE}/im/v1/messages/${upperMessageId}/resources/${resourceKey}?type=${resourceType}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e: any) {
    console.error(`Warning: Failed to download ${resourceType} ${resourceKey}: ${e.message}`);
    return null;
  }

  if (!res.ok) {
    console.error(`Warning: Failed to download ${resourceType} ${resourceKey}: HTTP ${res.status}`);
    return null;
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0');
  if (contentLength > MAX_FILE_SIZE) {
    console.error(`Warning: Skipping ${resourceKey} (${(contentLength / 1024 / 1024).toFixed(1)}MB > 30MB limit)`);
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length > MAX_FILE_SIZE) {
    console.error(`Warning: Skipping ${resourceKey} (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 30MB limit)`);
    return null;
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  let outName: string;
  if (fileName) {
    outName = `${datePrefix}-merge-${fileName}`;
    if (existsSync(join(outputDir, outName))) {
      const ext = extname(fileName);
      const base = fileName.slice(0, -ext.length || undefined);
      outName = `${datePrefix}-merge-${base}-${index}${ext}`;
    }
  } else {
    const ext = mimeToExt(contentType);
    outName = `${datePrefix}-merge-${typeLabel}-${String(index).padStart(3, '0')}${ext}`;
  }

  const outPath = join(outputDir, outName);
  writeFileSync(outPath, buffer);
  return outPath;
}

async function resolveSenderName(
  token: string,
  senderId: string,
  cache: Map<string, string>,
): Promise<string> {
  if (cache.has(senderId)) return cache.get(senderId)!;
  try {
    const data = await feishuGetJson(token, `/contact/v3/users/${senderId}?user_id_type=open_id`);
    const name = data?.data?.user?.name || senderId;
    cache.set(senderId, name);
    return name;
  } catch {
    cache.set(senderId, senderId);
    return senderId;
  }
}

function parseSubContent(sub: any): any {
  if (!sub?.body?.content) return {};
  try {
    return typeof sub.body.content === 'string' ? JSON.parse(sub.body.content) : sub.body.content;
  } catch {
    return {};
  }
}

export async function fetchMergeForwardContent(
  messageId: string,
  options?: FetchMergeOptions,
): Promise<MergeForwardResult> {
  const maxDepth = options?.maxDepth ?? 3;
  const outputDir = options?.outputDir || join(process.env.HOME || '~', '.gbrain', 'raw');

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const { appId, appSecret } = getAppCredentials();
  const token = await getTenantAccessToken(appId, appSecret);
  const nameCache = new Map<string, string>();
  const mediaFiles: string[] = [];
  const today = new Date().toISOString().split('T')[0];
  let mediaIndex = 1;

  async function processSubMessages(
    containerMessageId: string,
    subMessages: any[],
    depth: number,
  ): Promise<MergeSubMessage[]> {
    const results: MergeSubMessage[] = [];

    for (const sub of subMessages) {
      const senderId = sub?.sender?.id || sub?.sender_id || '';
      const senderName = senderId ? await resolveSenderName(token, senderId, nameCache) : 'Unknown';
      const timestamp = formatTimestamp(sub?.create_time || '');
      const subMsgType = sub?.msg_type || 'unknown';

      if (subMsgType === 'merge_forward') {
        if (depth >= maxDepth) {
          results.push({
            sender: senderName,
            sender_id: senderId,
            timestamp,
            type: 'text',
            text: '[Nested merge_forward exceeds max depth]',
          });
          continue;
        }

        const nestedId = sub?.message_id;
        if (nestedId) {
          const nested = await processMergeMessage(nestedId, depth + 1);
          results.push(...nested);
        } else {
          const nestedContent = parseSubContent(sub);
          const nestedSubs = nestedContent?.messages || nestedContent?.items || [];
          if (nestedSubs.length > 0) {
            const nested = await processSubMessages(containerMessageId, nestedSubs, depth + 1);
            results.push(...nested);
          } else {
            results.push({
              sender: senderName,
              sender_id: senderId,
              timestamp,
              type: 'text',
              text: '[Nested merge_forward - empty]',
            });
          }
        }
        continue;
      }

      const subContent = parseSubContent(sub);
      if (!sub?.body?.content) continue;

      const extracted = extractContent(subMsgType, subContent);
      const result: MergeSubMessage = {
        sender: senderName,
        sender_id: senderId,
        timestamp,
        type: subMsgType,
        text: extracted.text,
      };

      for (const resource of extracted.resources) {
        const dl = await downloadResource(
          token,
          containerMessageId,
          resource.key,
          resource.type,
          outputDir,
          today,
          resource.type === 'image' ? 'img' : 'file',
          mediaIndex,
          resource.fileName,
        );
        if (dl) {
          result.media_path = dl;
          if (resource.fileName) result.file_name = resource.fileName;
          mediaFiles.push(dl);
          mediaIndex++;
        }
      }

      results.push(result);
    }

    return results;
  }

  async function processMergeMessage(msgId: string, depth: number): Promise<MergeSubMessage[]> {
    const msgData = await feishuGetJson(token, `/im/v1/messages/${msgId}`);
    if (msgData.code !== 0) {
      throw new Error(`Failed to fetch message ${msgId}: ${msgData.msg} (code ${msgData.code})`);
    }

    const items = msgData?.data?.items;
    if (!items || items.length === 0) {
      throw new Error(`Message ${msgId}: empty items array`);
    }

    const msg = items[0];
    if (msg.msg_type !== 'merge_forward') {
      throw new Error(`Message ${msgId} is not a merge_forward message (got: ${msg.msg_type})`);
    }

    let content: any;
    try {
      content = typeof msg.body.content === 'string' ? JSON.parse(msg.body.content) : msg.body.content;
    } catch {
      throw new Error(`Failed to parse merge_forward content for ${msgId}`);
    }

    const subMessages = content?.messages || content?.items || [];
    if (subMessages.length === 0) {
      return [];
    }

    return processSubMessages(msgId, subMessages, depth);
  }

  const messages = await processMergeMessage(messageId, 0);

  const summaryLines = messages.map((m) => {
    let time = '??:??';
    if (m.timestamp) {
      try {
        const d = new Date(m.timestamp);
        time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      } catch {
        // keep ??:??
      }
    }
    return `- [${time}] [${m.sender}] ${m.text}`;
  });
  const text_summary = `[Merged and Forwarded Messages]\n${summaryLines.join('\n')}`;

  return {
    message_id: messageId,
    messages,
    media_files: mediaFiles,
    text_summary,
  };
}
