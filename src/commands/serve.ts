import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

export async function runServe(engine: BrainEngine) {
  console.error('Starting CFBrain MCP server (stdio)...');
  await startMcpServer(engine);

  // startMcpServer() resolves as soon as the stdio transport is *connected*,
  // not when the session ends. cli.ts does `main().then(() => process.exit(0))`,
  // so if we returned here the process would exit immediately and the server
  // would answer nothing — not even `initialize`.
  //
  // Stay alive until the MCP client goes away (stdin closes) or we are signalled.
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once('end', done);
    process.stdin.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });

  console.error('CFBrain MCP server stopped.');
}
