/**
 * `cfbrain ingest-minutes <url-or-token>` command.
 * Ingests a Feishu Minutes (妙记) and creates a CFBrain page.
 *
 * Workflow:
 * 1. Parse minute-token from URL or direct token
 * 2. Fetch notes (summary, todos, chapters, transcript) via lark-cli
 * 3. Save raw files: .url + transcript .txt
 * 4. Compile into standard CFBrain page
 * 5. Create page via put pipeline
 */

import { basename } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { writeRawText } from '../core/raw-files.ts';
import { importFromContent } from '../core/import-file.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { writePageFile, gitAutoCommit, getBrainDir } from '../core/pages-fs.ts';
import { appendChangelog, type ChangelogEntry } from '../core/changelog.ts';
import { parseMinuteToken, fetchMinutesNotes, compileMinutesPage } from '../core/extractors/minutes.ts';

export async function runIngestMinutes(engine: BrainEngine, args: string[]) {
  const input = args.find(a => !a.startsWith('--'));
  const slugArg = args.find((a, i) => args[i - 1] === '--slug');
  const noEmbed = args.includes('--no-embed');

  if (!input) {
    console.error('Usage: cfbrain ingest-minutes <url-or-token> [--slug <slug>] [--no-embed]');
    console.error('');
    console.error('Examples:');
    console.error('  cfbrain ingest-minutes https://xxx.feishu.cn/minutes/obcnXXXXXX');
    console.error('  cfbrain ingest-minutes obcnXXXXXX --slug weekly-standup');
    process.exit(1);
  }

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: cfbrain init');
    process.exit(1);
  }

  const minuteToken = parseMinuteToken(input);
  console.log(`Fetching minutes: ${minuteToken}...`);

  // 1. Fetch minutes content via lark-cli
  const minutes = await fetchMinutesNotes(minuteToken);
  console.log(`  Title: ${minutes.title}`);

  // 2. Derive slug
  const slug = slugArg || minutes.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    || `minutes-${minuteToken.slice(0, 8)}`;

  // 3. Build the source URL
  const sourceUrl = input.startsWith('http')
    ? input
    : `https://feishu.cn/minutes/${minuteToken}`;

  // 4. Compile the page content
  const content = compileMinutesPage(minutes, sourceUrl);

  // 5. Save raw files
  const rawSources: string[] = [];

  // Save URL reference
  const urlRaw = writeRawText(config, slug, '.url', sourceUrl);
  rawSources.push(urlRaw);

  // Save transcript if available
  if (minutes.transcript) {
    const transcriptRaw = writeRawText(config, slug, '.txt', minutes.transcript, '-transcript');
    rawSources.push(transcriptRaw);
    console.log(`  Transcript saved: ${transcriptRaw}`);
  }

  // 6. Inject raw_source into frontmatter and import
  const { parseMarkdown } = await import('../core/markdown.ts');
  const parsed = parseMarkdown(content);
  parsed.frontmatter.raw_source = rawSources.length === 1 ? rawSources[0] : rawSources;

  const finalContent = serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, {
    types: parsed.types,
    title: parsed.title,
    tags: parsed.tags,
  });

  // Check idempotency
  const existing = await engine.getPage(slug).catch(() => null);

  const importResult = await importFromContent(engine, slug, finalContent, { noEmbed });

  if (importResult.status === 'imported') {
    const brainDir = getBrainDir(config);
    const isCreate = !existing;

    // Write pages/ file
    try {
      const page = await engine.getPage(importResult.slug);
      const tags = await engine.getTags(importResult.slug);
      const md = serializeMarkdown(
        page.frontmatter,
        page.compiled_truth,
        { types: page.types, title: page.title, tags },
      );
      writePageFile(config, importResult.slug, md);
      gitAutoCommit(config, `ingest-minutes: ${importResult.slug} — ${isCreate ? 'Created' : 'Updated'} from Feishu Minutes`);
    } catch { /* silent */ }

    // Changelog
    const entry: ChangelogEntry = {
      action: isCreate ? 'created' : 'updated',
      slug: importResult.slug,
      reason: `Ingested from Feishu Minutes: ${minutes.title}`,
      source: 'cli',
      triggered_by: 'ingest-minutes',
    };
    appendChangelog(brainDir, entry).catch(() => {});

    console.log(`✅ ${isCreate ? 'Created' : 'Updated'}: ${importResult.slug} (meeting, ${importResult.chunks} chunks)`);
  } else {
    console.log(`Skipped: ${slug} (content unchanged)`);
  }
}
