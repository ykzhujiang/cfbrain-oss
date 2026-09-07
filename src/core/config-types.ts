import { DEFAULT_TYPES } from './types.ts';
import type { GBrainConfig } from './config.ts';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export function getConfiguredTypes(config: GBrainConfig | null | undefined): string[] {
  if (config?.type_labels && Object.keys(config.type_labels).length > 0) {
    return Object.keys(config.type_labels);
  }
  return [...DEFAULT_TYPES];
}

export function readConfig(dir: string): GBrainConfig | null {
  try {
    const raw = readFileSync(join(dir, 'config.json'), 'utf-8');
    return JSON.parse(raw) as GBrainConfig;
  } catch {
    return null;
  }
}

export function writeConfig(dir: string, config: GBrainConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
