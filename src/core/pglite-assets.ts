/**
 * PGLite WASM + extension asset loading.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * PGLite needs runtime payloads that live as side files in its npm package:
 *   - pglite.wasm      (~8.3 MB) the Postgres build
 *   - pglite.data      (~5.0 MB) the initial filesystem image
 *   - initdb.wasm      (~168 KB) the initdb helper
 *   - vector.tar.gz    (~48 KB)  the pgvector extension bundle
 *   - pg_trgm.tar.gz   (~12 KB)  the pg_trgm extension bundle
 *
 * Run from source, PGLite resolves all of these relative to its own module and
 * everything works. In a `bun build --compile` single-file executable the module
 * lives in Bun's virtual filesystem and the side files are NOT bundled, so you get:
 *
 *     ENOENT: open '/$bunfs/root/pglite.data'
 *     error: Extension bundle not found: file:///$bunfs/pg_trgm.tar.gz
 *
 * Copying the files next to the binary does not help — the lookup paths are baked
 * to `/$bunfs/`.
 *
 * THE FIX
 * -------
 * Import every payload with `with { type: 'file' }` so Bun embeds it in the
 * executable, then:
 *   - hand the WASM/data payloads straight to `PGlite.create()` via its documented
 *     `pgliteWasmModule` / `initdbWasmModule` / `fsBundle` options;
 *   - for extensions, PGLite only accepts a `bundlePath: URL` and reads `file:`
 *     URLs off the real filesystem, so materialise the embedded tarballs into a
 *     cache directory once and point at those.
 *
 * Everything degrades gracefully: if any step fails we return null and the caller
 * falls back to PGLite's own resolution, which is correct when running from source.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VERSION } from '../version.ts';

// Specifiers are relative to src/core/ → <repo>/node_modules/...
// Bun embeds each file and rewrites the value to a path inside its virtual FS.
import pgliteWasmPath from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
import pgliteDataPath from '../../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };
import initdbWasmPath from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' };
import vectorBundlePath from '../../node_modules/@electric-sql/pglite/dist/vector.tar.gz' with { type: 'file' };
import trgmBundlePath from '../../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz' with { type: 'file' };

export interface PGliteAssets {
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
}

let cachedAssets: PGliteAssets | null = null;
let assetsFailed = false;

/**
 * Core WASM payloads, compiled and ready to pass to PGlite.create().
 * Returns null if unavailable (caller should let PGLite resolve them itself).
 */
export async function getPgliteAssets(): Promise<PGliteAssets | null> {
  if (cachedAssets) return cachedAssets;
  if (assetsFailed) return null;

  try {
    const [pgliteWasmBytes, initdbWasmBytes, fsBytes] = await Promise.all([
      Bun.file(pgliteWasmPath).arrayBuffer(),
      Bun.file(initdbWasmPath).arrayBuffer(),
      Bun.file(pgliteDataPath).arrayBuffer(),
    ]);

    const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
      WebAssembly.compile(pgliteWasmBytes),
      WebAssembly.compile(initdbWasmBytes),
    ]);

    cachedAssets = {
      pgliteWasmModule,
      initdbWasmModule,
      fsBundle: new Blob([fsBytes]),
    };
    return cachedAssets;
  } catch {
    assetsFailed = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extension bundles
// ---------------------------------------------------------------------------

/** Where extracted extension tarballs are cached, keyed by CLI version. */
function extensionCacheDir(): string {
  return join(tmpdir(), `cfbrain-pglite-ext-${VERSION}`);
}

/**
 * Materialise an embedded tarball onto the real filesystem and return a file: URL.
 * Idempotent: written once per version, reused afterwards.
 */
async function materialiseBundle(embeddedPath: string, fileName: string): Promise<URL> {
  const dir = extensionCacheDir();
  const dest = join(dir, fileName);

  if (!existsSync(dest)) {
    mkdirSync(dir, { recursive: true });
    const bytes = await Bun.file(embeddedPath).arrayBuffer();
    // Write to a temp name then rename, so two concurrent processes cannot
    // observe a half-written tarball.
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, new Uint8Array(bytes));
    try {
      require('fs').renameSync(tmp, dest);
    } catch {
      // Another process won the race; its file is equally valid.
      try { require('fs').unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  return new URL(`file://${dest}`);
}

/** Minimal shape of a PGLite extension. */
interface PGliteExtension {
  name: string;
  setup: (pg: unknown, emscriptenOpts: unknown, clientOnly?: boolean) => Promise<{
    emscriptenOpts?: unknown;
    bundlePath?: URL;
  }>;
}

let cachedExtensions: Record<string, PGliteExtension> | null = null;
let extensionsFailed = false;

/**
 * Extensions whose bundles resolve from the embedded copies.
 *
 * Returns null if extraction fails, in which case the caller should use the
 * extensions imported normally from the pglite package.
 */
export async function getEmbeddedExtensions(): Promise<Record<string, PGliteExtension> | null> {
  if (cachedExtensions) return cachedExtensions;
  if (extensionsFailed) return null;

  try {
    const [vectorUrl, trgmUrl] = await Promise.all([
      materialiseBundle(vectorBundlePath, 'vector.tar.gz'),
      materialiseBundle(trgmBundlePath, 'pg_trgm.tar.gz'),
    ]);

    cachedExtensions = {
      vector: {
        name: 'pgvector',
        setup: async (_pg, emscriptenOpts) => ({ emscriptenOpts, bundlePath: vectorUrl }),
      },
      pg_trgm: {
        name: 'pg_trgm',
        setup: async () => ({ bundlePath: trgmUrl }),
      },
    };
    return cachedExtensions;
  } catch {
    extensionsFailed = true;
    return null;
  }
}
