/**
 * Feishu Minutes (妙记) extractor.
 * Uses lark-cli to fetch meeting minutes content: summary, todos, chapters, transcript.
 */

import { runLarkCli } from '../feishu.ts';

export interface MinutesContent {
  title: string;
  duration?: number;
  createTime?: number;
  owner?: { name?: string };
  summary?: string;
  todos?: Array<{ content: string; assignee?: string; done?: boolean }>;
  chapters?: Array<{ title: string; startTime?: number; content?: string }>;
  transcript?: string;
}

/**
 * Extract minute-token from a Feishu minutes URL.
 * URL formats:
 *   https://xxx.feishu.cn/minutes/XXX
 *   https://xxx.larksuite.com/minutes/XXX
 *   Or just the token directly.
 */
export function parseMinuteToken(input: string): string {
  // If it looks like a URL, extract the last path segment
  const urlMatch = input.match(/\/minutes\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  // Otherwise treat the whole input as a token
  return input.trim();
}

/**
 * Fetch minutes notes (AI summary, todos, chapters) from lark-cli.
 */
export async function fetchMinutesNotes(minuteToken: string): Promise<MinutesContent> {
  const raw = await runLarkCli(['minutes', '+notes', '--minute-token', minuteToken]);

  // lark-cli returns JSON
  const trimmed = raw.trim();
  let data: any;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Try finding JSON in output (lark-cli sometimes prefixes with status lines)
    const jsonStart = trimmed.search(/[\[{]/);
    if (jsonStart !== -1) {
      data = JSON.parse(trimmed.slice(jsonStart));
    } else {
      throw new Error(`Failed to parse minutes notes output: ${trimmed.slice(0, 200)}`);
    }
  }

  // Normalize the response — handle both top-level and nested data shapes
  const notes = data.data ?? data;

  return {
    title: notes.title || notes.topic || 'Untitled Meeting',
    duration: notes.duration,
    createTime: notes.create_time,
    owner: notes.owner,
    summary: notes.summary || notes.ai_summary,
    todos: (notes.action_items || notes.todos || []).map((item: any) => ({
      content: item.content || item.text || String(item),
      assignee: item.assignee?.name || item.assignee,
      done: item.is_done || item.done || false,
    })),
    chapters: (notes.chapters || []).map((ch: any) => ({
      title: ch.title || ch.topic || '',
      startTime: ch.start_time,
      content: ch.content || ch.summary || '',
    })),
    transcript: notes.transcript,
  };
}

/**
 * Compile minutes content into a standard CFBrain markdown page.
 */
export function compileMinutesPage(minutes: MinutesContent, sourceUrl: string): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push('types: [meeting]');
  lines.push(`title: "${minutes.title.replace(/"/g, '\\"')}"`);
  lines.push(`source_url: "${sourceUrl}"`);
  if (minutes.createTime) {
    const date = new Date(minutes.createTime * 1000).toISOString().slice(0, 10);
    lines.push(`date: "${date}"`);
  }
  lines.push('---');
  lines.push('');

  // Summary
  if (minutes.summary) {
    lines.push('## 摘要');
    lines.push('');
    lines.push(minutes.summary);
    lines.push('');
  }

  // Todos / Action Items
  if (minutes.todos && minutes.todos.length > 0) {
    lines.push('## 待办事项');
    lines.push('');
    for (const todo of minutes.todos) {
      const check = todo.done ? '[x]' : '[ ]';
      const assignee = todo.assignee ? ` (@${todo.assignee})` : '';
      lines.push(`- ${check} ${todo.content}${assignee}`);
    }
    lines.push('');
  }

  // Chapters
  if (minutes.chapters && minutes.chapters.length > 0) {
    lines.push('## 章节');
    lines.push('');
    for (const ch of minutes.chapters) {
      lines.push(`### ${ch.title || '(未命名章节)'}`);
      lines.push('');
      if (ch.content) {
        lines.push(ch.content);
        lines.push('');
      }
    }
  }

  // Transcript
  if (minutes.transcript) {
    lines.push('## 逐字稿');
    lines.push('');
    lines.push(minutes.transcript);
    lines.push('');
  }

  return lines.join('\n');
}
