import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MOCK_TOKEN = 'test-tenant-token-12345';
const MOCK_MSG_ID = 'om_test_merge_123';

function makeMergeMessage(items: any[]) {
  return {
    code: 0,
    msg: 'success',
    data: {
      items: [
        {
          message_id: MOCK_MSG_ID,
          msg_type: 'merge_forward',
          create_time: '1713600000000',
          sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user' },
          body: {
            content: JSON.stringify({ messages: items }),
          },
        },
      ],
    },
  };
}

function textSubMsg(text: string, senderId = 'ou_alice', createTime = '1713600060000') {
  return {
    sender: { id: senderId, id_type: 'open_id' },
    create_time: createTime,
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
  };
}

function imageSubMsg(imageKey: string, senderId = 'ou_bob', createTime = '1713600120000') {
  return {
    sender: { id: senderId, id_type: 'open_id' },
    create_time: createTime,
    msg_type: 'image',
    body: { content: JSON.stringify({ image_key: imageKey }) },
  };
}

function fileSubMsg(fileKey: string, fileName: string, senderId = 'ou_charlie', createTime = '1713600180000') {
  return {
    sender: { id: senderId, id_type: 'open_id' },
    create_time: createTime,
    msg_type: 'file',
    body: { content: JSON.stringify({ file_key: fileKey, file_name: fileName }) },
  };
}

function nestedMergeSubMsg(messageId: string, senderId = 'ou_dave', createTime = '1713600240000') {
  return {
    message_id: messageId,
    sender: { id: senderId, id_type: 'open_id' },
    create_time: createTime,
    msg_type: 'merge_forward',
    body: { content: '{}' },
  };
}

function userResponse(name: string) {
  return { code: 0, data: { user: { name } } };
}

function mockFetch(handlers: Record<string, () => any>) {
  const original = globalThis.fetch;
  const resourceHandlers = Object.entries(handlers).filter(([k]) => k.includes('/resources/'));
  const otherHandlers = Object.entries(handlers).filter(([k]) => !k.includes('/resources/'));

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: MOCK_TOKEN }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const candidates = urlStr.includes('/resources/') ? resourceHandlers : otherHandlers;
    for (const [pattern, handler] of candidates) {
      if (urlStr.includes(pattern)) {
        const result = handler();
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ code: 99999, msg: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'spec45-'));
  process.env.LARK_APP_ID = 'test-app-id';
  process.env.LARK_APP_SECRET = 'test-app-secret';
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LARK_APP_ID;
  delete process.env.LARK_APP_SECRET;
});

describe('Spec 45: Merge-Forward Message Ingestion', () => {
  test('extracts text messages from merge_forward', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('Hello world'),
          textSubMsg('Second message', 'ou_bob', '1713600120000'),
        ]),
      '/contact/v3/users/ou_alice': () => userResponse('Alice'),
      '/contact/v3/users/ou_bob': () => userResponse('Bob'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.message_id).toBe(MOCK_MSG_ID);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].text).toBe('Hello world');
      expect(result.messages[0].sender).toBe('Alice');
      expect(result.messages[0].type).toBe('text');
      expect(result.messages[1].text).toBe('Second message');
      expect(result.messages[1].sender).toBe('Bob');
      expect(result.media_files).toHaveLength(0);
      expect(result.text_summary).toContain('[Merged and Forwarded Messages]');
      expect(result.text_summary).toContain('Alice');
      expect(result.text_summary).toContain('Hello world');
    } finally {
      restore();
    }
  });

  test('downloads images from merge_forward', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([imageSubMsg('img_key_001')]),
      '/contact/v3/users/ou_bob': () => userResponse('Bob'),
      '/resources/img_key_001': () =>
        new Response(pngBytes, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(pngBytes.length),
          },
        }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('image');
      expect(result.messages[0].text).toBe('[Image]');
      expect(result.messages[0].media_path).toBeDefined();
      expect(result.media_files).toHaveLength(1);

      const downloadedFile = result.media_files[0];
      expect(existsSync(downloadedFile)).toBe(true);
      expect(downloadedFile).toContain('.png');
      const content = readFileSync(downloadedFile);
      expect(content[0]).toBe(0x89);
    } finally {
      restore();
    }
  });

  test('downloads files from merge_forward', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content');
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([fileSubMsg('file_key_001', 'report.pdf')]),
      '/contact/v3/users/ou_charlie': () => userResponse('Charlie'),
      '/resources/file_key_001': () =>
        new Response(pdfBytes, {
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(pdfBytes.length),
          },
        }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('file');
      expect(result.messages[0].text).toBe('[File: report.pdf]');
      expect(result.messages[0].file_name).toBe('report.pdf');
      expect(result.messages[0].media_path).toBeDefined();
      expect(result.media_files).toHaveLength(1);
      expect(existsSync(result.media_files[0])).toBe(true);
      expect(result.media_files[0]).toContain('report.pdf');
    } finally {
      restore();
    }
  });

  test('handles nested merge_forward recursively', async () => {
    const nestedMsgId = 'om_nested_merge_456';
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('Before nested'),
          nestedMergeSubMsg(nestedMsgId),
        ]),
      [`/im/v1/messages/${nestedMsgId}`]: () =>
        makeMergeMessage([textSubMsg('Nested message', 'ou_nested')]),
      '/contact/v3/users/ou_alice': () => userResponse('Alice'),
      '/contact/v3/users/ou_dave': () => userResponse('Dave'),
      '/contact/v3/users/ou_nested': () => userResponse('Nested User'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      const texts = result.messages.map((m) => m.text);
      expect(texts).toContain('Before nested');
      expect(texts).toContain('Nested message');
    } finally {
      restore();
    }
  });

  test('respects max depth for nested merge_forward', async () => {
    const nestedMsgId = 'om_deep_nested';
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([nestedMergeSubMsg(nestedMsgId)]),
      [`/im/v1/messages/${nestedMsgId}`]: () => ({
        code: 0,
        msg: 'success',
        data: {
          items: [
            {
              message_id: nestedMsgId,
              msg_type: 'merge_forward',
              create_time: '1713600000000',
              sender: { id: 'ou_x', id_type: 'open_id' },
              body: {
                content: JSON.stringify({
                  messages: [nestedMergeSubMsg('om_deeper')],
                }),
              },
            },
          ],
        },
      }),
      '/contact/v3/users/': () => userResponse('User'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, {
        outputDir: tmpDir,
        maxDepth: 1,
      });

      const texts = result.messages.map((m) => m.text);
      expect(texts.some((t) => t.includes('exceeds max depth'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('resolves sender names via Contact API', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('msg1', 'ou_user1'),
          textSubMsg('msg2', 'ou_user2'),
          textSubMsg('msg3', 'ou_user1'),
        ]),
      '/contact/v3/users/ou_user1': () => userResponse('Zhang San'),
      '/contact/v3/users/ou_user2': () => userResponse('Li Si'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages[0].sender).toBe('Zhang San');
      expect(result.messages[1].sender).toBe('Li Si');
      expect(result.messages[2].sender).toBe('Zhang San');
    } finally {
      restore();
    }
  });

  test('falls back to open_id when Contact API fails', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([textSubMsg('hello', 'ou_unknown')]),
      '/contact/v3/users/ou_unknown': () => {
        throw new Error('network error');
      },
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages[0].sender).toBe('ou_unknown');
    } finally {
      restore();
    }
  });

  test('handles empty items array', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () => ({
        code: 0,
        msg: 'success',
        data: { items: [] },
      }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      await expect(
        fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir }),
      ).rejects.toThrow('empty items');
    } finally {
      restore();
    }
  });

  test('handles non-merge_forward message type', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () => ({
        code: 0,
        msg: 'success',
        data: {
          items: [
            {
              message_id: MOCK_MSG_ID,
              msg_type: 'text',
              create_time: '1713600000000',
              sender: { id: 'ou_x', id_type: 'open_id' },
              body: { content: '{"text":"hello"}' },
            },
          ],
        },
      }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      await expect(
        fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir }),
      ).rejects.toThrow('not a merge_forward');
    } finally {
      restore();
    }
  });

  test('handles media download failure gracefully', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([imageSubMsg('img_broken')]),
      '/contact/v3/users/ou_bob': () => userResponse('Bob'),
      '/resources/img_broken': () =>
        new Response('Not Found', { status: 404 }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('image');
      expect(result.messages[0].text).toBe('[Image]');
      expect(result.messages[0].media_path).toBeUndefined();
      expect(result.media_files).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('skips files exceeding 30MB', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([fileSubMsg('file_huge', 'huge.zip')]),
      '/contact/v3/users/ou_charlie': () => userResponse('Charlie'),
      '/resources/file_huge': () =>
        new Response(Buffer.alloc(10), {
          headers: {
            'content-type': 'application/zip',
            'content-length': String(31 * 1024 * 1024),
          },
        }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages[0].media_path).toBeUndefined();
      expect(result.media_files).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('handles unknown message types as text placeholders', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          {
            sender: { id: 'ou_x', id_type: 'open_id' },
            create_time: '1713600060000',
            msg_type: 'location',
            body: { content: JSON.stringify({ name: 'Office' }) },
          },
        ]),
      '/contact/v3/users/ou_x': () => userResponse('User X'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages[0].text).toBe('[location]');
      expect(result.messages[0].type).toBe('location');
    } finally {
      restore();
    }
  });

  test('formats timestamps as ISO 8601', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([textSubMsg('test', 'ou_x', '1713600060000')]),
      '/contact/v3/users/ou_x': () => userResponse('X'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.messages[0].timestamp).toContain('T');
    } finally {
      restore();
    }
  });

  test('generates text_summary with correct format', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('Hello', 'ou_a', '1713600060000'),
          imageSubMsg('img_k', 'ou_b', '1713600120000'),
          fileSubMsg('file_k', 'doc.pdf', 'ou_c', '1713600180000'),
        ]),
      '/contact/v3/users/ou_a': () => userResponse('Alice'),
      '/contact/v3/users/ou_b': () => userResponse('Bob'),
      '/contact/v3/users/ou_c': () => userResponse('Charlie'),
      '/resources/img_k': () =>
        new Response(Buffer.from([0x89, 0x50]), {
          headers: { 'content-type': 'image/png', 'content-length': '2' },
        }),
      '/resources/file_k': () =>
        new Response(Buffer.from('pdf'), {
          headers: { 'content-type': 'application/pdf', 'content-length': '3' },
        }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.text_summary).toStartWith('[Merged and Forwarded Messages]');
      expect(result.text_summary).toContain('[Alice]');
      expect(result.text_summary).toContain('Hello');
      expect(result.text_summary).toContain('[Bob]');
      expect(result.text_summary).toContain('[Image]');
      expect(result.text_summary).toContain('[Charlie]');
      expect(result.text_summary).toContain('[File: doc.pdf]');
    } finally {
      restore();
    }
  });

  test('requires LARK_APP_ID and LARK_APP_SECRET', async () => {
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      await expect(
        fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir }),
      ).rejects.toThrow('LARK_APP_ID');
    } finally {
      process.env.LARK_APP_ID = 'test-app-id';
      process.env.LARK_APP_SECRET = 'test-app-secret';
    }
  });

  test('creates output directory if it does not exist', async () => {
    const nestedDir = join(tmpDir, 'nested', 'output');
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([textSubMsg('test')]),
      '/contact/v3/users/ou_alice': () => userResponse('Alice'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: nestedDir });

      expect(existsSync(nestedDir)).toBe(true);
      expect(result.messages).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('handles mixed content types in single merge_forward', async () => {
    const imgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const pdfBytes = Buffer.from('%PDF-1.5');
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('Start of discussion'),
          imageSubMsg('img_mix_1', 'ou_a', '1713600120000'),
          textSubMsg('Middle text', 'ou_b', '1713600180000'),
          fileSubMsg('file_mix_1', 'notes.pdf', 'ou_c', '1713600240000'),
          textSubMsg('End of discussion', 'ou_a', '1713600300000'),
        ]),
      '/contact/v3/users/ou_a': () => userResponse('Alice'),
      '/contact/v3/users/ou_b': () => userResponse('Bob'),
      '/contact/v3/users/ou_c': () => userResponse('Charlie'),
      '/resources/img_mix_1': () =>
        new Response(imgBytes, {
          headers: { 'content-type': 'image/jpeg', 'content-length': String(imgBytes.length) },
        }),
      '/resources/file_mix_1': () =>
        new Response(pdfBytes, {
          headers: { 'content-type': 'application/pdf', 'content-length': String(pdfBytes.length) },
        }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(5);
      expect(result.messages[0].type).toBe('text');
      expect(result.messages[1].type).toBe('image');
      expect(result.messages[2].type).toBe('text');
      expect(result.messages[3].type).toBe('file');
      expect(result.messages[4].type).toBe('text');
      expect(result.media_files).toHaveLength(2);
      expect(result.media_files.every((f) => existsSync(f))).toBe(true);
    } finally {
      restore();
    }
  });

  test('handles API error response', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () => ({
        code: 230001,
        msg: 'message not found',
        data: null,
      }),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      await expect(
        fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir }),
      ).rejects.toThrow('message not found');
    } finally {
      restore();
    }
  });

  test('handles sub-messages with no body.content', async () => {
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          textSubMsg('valid message'),
          {
            sender: { id: 'ou_x', id_type: 'open_id' },
            create_time: '1713600120000',
            msg_type: 'text',
            body: {},
          },
          textSubMsg('after empty', 'ou_y', '1713600180000'),
        ]),
      '/contact/v3/users/ou_alice': () => userResponse('Alice'),
      '/contact/v3/users/ou_y': () => userResponse('Y'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].text).toBe('valid message');
      expect(result.messages[1].text).toBe('after empty');
    } finally {
      restore();
    }
  });

  test('handles post (rich text) message type', async () => {
    const postContent = {
      title: 'Rich Text Post',
      content: [
        [
          { tag: 'text', text: 'Hello ' },
          { tag: 'a', text: 'link', href: 'https://example.com' },
          { tag: 'at', user_name: 'Alice', user_id: 'ou_alice' },
        ],
        [
          { tag: 'text', text: 'Second line' },
        ],
      ],
    };
    const restore = mockFetch({
      [`/im/v1/messages/${MOCK_MSG_ID}`]: () =>
        makeMergeMessage([
          {
            sender: { id: 'ou_poster', id_type: 'open_id' },
            create_time: '1713600060000',
            msg_type: 'post',
            body: { content: JSON.stringify(postContent) },
          },
        ]),
      '/contact/v3/users/ou_poster': () => userResponse('Poster'),
    });
    try {
      const { fetchMergeForwardContent } = await import('../src/core/feishu-merge.ts');
      const result = await fetchMergeForwardContent(MOCK_MSG_ID, { outputDir: tmpDir });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe('post');
      expect(result.messages[0].text).toContain('Rich Text Post');
      expect(result.messages[0].text).toContain('Hello');
      expect(result.messages[0].text).toContain('link');
      expect(result.messages[0].text).toContain('@Alice');
    } finally {
      restore();
    }
  });
});
