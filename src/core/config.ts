import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';
import type { StorageConfig } from './storage.ts';

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments)
function getConfigDir() {
  const newDir = join(homedir(), '.cfbrain');
  const oldDir = join(homedir(), '.gbrain');
  // Backward compat: if ~/.cfbrain doesn't exist but ~/.gbrain does, use the old path
  if (!existsSync(newDir) && existsSync(oldDir)) return oldDir;
  return newDir;
}
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface FeishuConfig {
  enabled: boolean;
  space_id: string;
  auto_push: boolean;
  type_labels: Record<string, string>;
  root_node_tokens?: Record<string, string>;
  trash_node_token?: string;
}

export const DEFAULT_TYPE_LABELS: Record<string, string> = {
  person: '关键人物',
  company: '公司/组织',
  meeting: '会议',
  project: '项目',
  decision: '决策',
  concept: '概念/框架',
  intel: '情报',
  deal: '交易',
  note: '笔记/灵感',
  recruit: '招聘',
};

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  type_labels?: Record<string, string>;
  feishu?: FeishuConfig;
  storage?: StorageConfig;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfig;
  } catch { /* no config file */ }

  // Try env vars (support both CFBRAIN_DATABASE_URL and legacy GBRAIN_DATABASE_URL)
  const dbUrl = process.env.CFBRAIN_DATABASE_URL || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

  if (!fileConfig && !dbUrl) return null;

  // Infer engine type if not explicitly set
  const inferredEngine: 'postgres' | 'pglite' = fileConfig?.engine
    || (fileConfig?.database_path ? 'pglite' : 'postgres');

  // Merge: env vars override config file
  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { anthropic_api_key: process.env.ANTHROPIC_API_KEY } : {}),
  };
  return merged as GBrainConfig;
}

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function toEngineConfig(config: GBrainConfig): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
  };
}

export function configDir(): string {
  const newDir = join(homedir(), '.cfbrain');
  const oldDir = join(homedir(), '.gbrain');
  if (!existsSync(newDir) && existsSync(oldDir)) return oldDir;
  return newDir;
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}
