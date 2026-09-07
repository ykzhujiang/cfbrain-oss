import { execSync } from 'child_process';
import { readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { saveConfig, DEFAULT_TYPE_LABELS, type GBrainConfig } from '../core/config.ts';
import { DEFAULT_TYPES } from '../core/types.ts';
import { createEngine } from '../core/engine-factory.ts';
import { isLarkCliAvailable } from '../core/feishu.ts';

export async function runInit(args: string[]) {
  const isSupabase = args.includes('--supabase');
  const isPGLite = args.includes('--pglite');
  const isNonInteractive = args.includes('--non-interactive');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.indexOf('--path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  // Explicit PGLite mode
  if (isPGLite || (!isSupabase && !manualUrl && !isNonInteractive)) {
    // Smart detection: scan for .md files unless --pglite flag forces it
    if (!isPGLite && !isSupabase) {
      const fileCount = countMarkdownFiles(process.cwd());
      if (fileCount >= 1000) {
        console.log(`Found ~${fileCount} .md files. For a brain this size, Supabase gives faster`);
        console.log('search and remote access ($25/mo). PGLite works too but search will be slower at scale.');
        console.log('');
        console.log('  cfbrain init --supabase   Set up with Supabase (recommended for large brains)');
        console.log('  cfbrain init --pglite     Use local PGLite anyway');
        console.log('');
        // Default to PGLite, let the user choose Supabase if they want
      }
    }

    return initPGLite({ jsonOutput, apiKey, customPath });
  }

  // Supabase/Postgres mode
  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.CFBRAIN_DATABASE_URL || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or CFBRAIN_DATABASE_URL env var');
      process.exit(1);
    }
  } else {
    databaseUrl = await supabaseWizard();
  }

  return initPostgres({ databaseUrl, jsonOutput, apiKey });
}

async function initPGLite(opts: { jsonOutput: boolean; apiKey: string | null; customPath: string | null }) {
  const dbPath = opts.customPath || join(homedir(), '.cfbrain', 'brain.pglite');
  console.log(`Setting up local brain with PGLite (no server needed)...`);

  // PGLite creates the database directory itself, but not its parents. On a
  // first-ever install ~/.cfbrain does not exist yet, so create it up front.
  mkdirSync(dirname(dbPath), { recursive: true });

  const engine = await createEngine({ engine: 'pglite' });
  await engine.connect({ database_path: dbPath, engine: 'pglite' });
  await engine.initSchema();

  const config: GBrainConfig = {
    engine: 'pglite',
    database_path: dbPath,
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
    type_labels: DEFAULT_TYPE_LABELS,
  };
  saveConfig(config);

  // Create pages/ and raw/ directories with git init in the brain dir
  const brainDir = dirname(dbPath);
  initBrainDirs(brainDir);

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: 'pglite', path: dbPath, pages: stats.page_count, types: DEFAULT_TYPES }));
  } else {
    console.log(`\nBrain ready at ${dbPath}`);
    console.log(`${stats.page_count} pages. Engine: PGLite (local Postgres).`);
    console.log(`Types: ${DEFAULT_TYPES.join(', ')}`);
    console.log('Next: cfbrain import <dir>');
    console.log('');
    console.log('When you outgrow local: cfbrain migrate --to supabase');
  }

  // Suggest Feishu integration if lark-cli is available
  if (!opts.jsonOutput && await isLarkCliAvailable()) {
    console.log('');
    console.log('Tip: lark-cli detected. You can sync your brain to Feishu/Lark wiki:');
    console.log('  cfbrain feishu --setup');
  }
}

async function initPostgres(opts: { databaseUrl: string; jsonOutput: boolean; apiKey: string | null }) {
  const { databaseUrl } = opts;

  // Detect Supabase direct connection URLs and warn about IPv6
  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  console.log('Connecting to database...');
  const engine = await createEngine({ engine: 'postgres' });
  try {
    await engine.connect({ database_url: databaseUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
      console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
      console.error('Use the Session pooler connection string instead (port 6543).');
    }
    throw e;
  }

  // Check and auto-create pgvector extension
  try {
    const ext = await engine.executeRaw(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    if (ext.length === 0) {
      console.log('pgvector extension not found. Attempting to create...');
      try {
        await engine.executeRaw(`CREATE EXTENSION IF NOT EXISTS vector`);
        console.log('pgvector extension created successfully.');
      } catch {
        console.error('Could not auto-create pgvector extension. Run manually in SQL Editor:');
        console.error('  CREATE EXTENSION vector;');
        await engine.disconnect();
        process.exit(1);
      }
    }
  } catch {
    // Non-fatal
  }

  console.log('Running schema migration...');
  await engine.initSchema();

  const config: GBrainConfig = {
    engine: 'postgres',
    database_url: databaseUrl,
    ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
    type_labels: DEFAULT_TYPE_LABELS,
  };
  saveConfig(config);
  console.log('Config saved to ~/.cfbrain/config.json');

  // Create pages/ and raw/ directories with git init in the brain dir
  const brainDir = join(homedir(), '.cfbrain');
  initBrainDirs(brainDir);

  const stats = await engine.getStats();
  await engine.disconnect();

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: 'postgres', pages: stats.page_count, types: DEFAULT_TYPES }));
  } else {
    console.log(`\nBrain ready. ${stats.page_count} pages. Engine: Postgres (Supabase).`);
    console.log(`Types: ${DEFAULT_TYPES.join(', ')}`);
    console.log('Next: cfbrain import <dir>');
  }

  // Suggest Feishu integration if lark-cli is available
  if (!opts.jsonOutput && await isLarkCliAvailable()) {
    console.log('');
    console.log('Tip: lark-cli detected. You can sync your brain to Feishu/Lark wiki:');
    console.log('  cfbrain feishu --setup');
  }
}

/**
 * Create pages/ and raw/ directories in the brain dir, git init at brain dir level.
 * Idempotent — safe to call on existing brain directories.
 */
export function initBrainDirs(brainDir: string) {
  const pagesDir = join(brainDir, 'pages');
  const rawDir = join(brainDir, 'raw');

  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  // Git init at brain dir level (tracks both pages/ and raw/)
  // Migrate: if pages/.git exists but brainDir/.git doesn't, move the repo up
  if (existsSync(join(pagesDir, '.git')) && !existsSync(join(brainDir, '.git'))) {
    try {
      // Move the git repo from pages/ to brain dir
      const { renameSync } = require('fs');
      renameSync(join(pagesDir, '.git'), join(brainDir, '.git'));
    } catch {
      // Fall through to git init below
    }
  }

  if (!existsSync(join(brainDir, '.git'))) {
    try {
      execSync('git init', { cwd: brainDir, stdio: 'pipe' });
    } catch {
      // Non-fatal — pages/ still works without git
    }
  }

  // Add .gitignore for database files but NOT raw/
  const gitignorePath = join(brainDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const { writeFileSync } = require('fs');
    writeFileSync(gitignorePath, '*.db\n*.db-wal\n*.db-shm\nPGDATA/\n');
  }
}

/**
 * Quick count of .md files in a directory (stops early at 1000).
 */
function countMarkdownFiles(dir: string, maxScan = 1500): number {
  let count = 0;
  try {
    const scan = (d: string) => {
      if (count >= maxScan) return;
      for (const entry of readdirSync(d)) {
        if (count >= maxScan) return;
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(d, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) scan(full);
          else if (entry.endsWith('.md')) count++;
        } catch { /* skip unreadable */ }
      }
    };
    scan(dir);
  } catch { /* skip unreadable root */ }
  return count;
}

async function supabaseWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: cfbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
  }

  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres');
  console.log('  Find it: Supabase Dashboard > Connect (top bar) > Connection String > Session Pooler\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}
