/**
 * Guided Feishu prerequisite setup.
 *
 * CFBrain's knowledge base is fully self-contained, but Feishu sync shells out
 * to `lark-cli` (the official @larksuite/cli). Rather than making a new user
 * discover that from an error message, `cfbrain feishu setup` detects what is
 * missing, explains why it is needed, asks permission, and installs it.
 *
 * Design rules:
 *   - Never install anything without explicit consent (or --yes).
 *   - Never hang when there is no TTY (CI, piped input): print instructions and exit.
 *   - Every step is idempotent and safe to re-run.
 *   - Interactive lark-cli steps (browser auth) run with inherited stdio so the
 *     user sees the verification URL and can complete it normally.
 */

import { runLarkCli, isLarkCliAvailable } from '../core/feishu.ts';

const LARK_PACKAGE = '@larksuite/cli';

interface AuthStatus {
  configured: boolean;
  userReady: boolean;
  botReady: boolean;
  appId?: string;
  userName?: string;
  raw?: string;
}

/** True when we can actually prompt a human. */
function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a yes/no question. Returns the default when we cannot prompt. */
async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!canPrompt()) return false;
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  process.stdout.write(`${question} ${suffix} `);

  for await (const chunk of Bun.stdin.stream()) {
    const answer = new TextDecoder().decode(chunk).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  }
  return defaultYes;
}

/** Run a command with inherited stdio so the user can interact with it. */
async function runInteractive(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  return (await proc.exited) === 0;
}

function commandExists(bin: string): boolean {
  try {
    return Bun.spawnSync(['which', bin]).exitCode === 0;
  } catch {
    return false;
  }
}

async function readAuthStatus(): Promise<AuthStatus> {
  try {
    const raw = await runLarkCli(['auth', 'status']);
    const parsed = JSON.parse(raw) as {
      appId?: string;
      identities?: {
        user?: { status?: string; available?: boolean; userName?: string };
        bot?: { status?: string; available?: boolean };
      };
    };
    const user = parsed.identities?.user;
    const bot = parsed.identities?.bot;
    // "ready" and "needs_refresh" both mean a usable token exists —
    // needs_refresh auto-refreshes on the next call.
    const usable = (s?: string) => s === 'ready' || s === 'needs_refresh';
    return {
      configured: true,
      userReady: Boolean(user?.available) && usable(user?.status),
      botReady: Boolean(bot?.available) && usable(bot?.status),
      appId: parsed.appId,
      userName: user?.userName,
      raw,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { configured: !msg.includes('not_configured'), userReady: false, botReady: false, raw: msg };
  }
}

export async function runFeishuSetup(args: string[]): Promise<void> {
  const autoYes = args.includes('--yes') || args.includes('-y');
  const checkOnly = args.includes('--check');

  const ok = (m: string) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
  const miss = (m: string) => console.log(`  \x1b[33m--\x1b[0m    ${m}`);
  const bad = (m: string) => console.log(`  \x1b[31mfail\x1b[0m  ${m}`);
  const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

  console.log('Feishu integration setup\n');
  console.log('CFBrain works fully without Feishu. This is only needed if you want to');
  console.log('sync your brain into a Feishu (Lark) wiki.\n');
  console.log('It relies on lark-cli, the official Feishu CLI, for authentication and API calls.');

  // ---- 1. lark-cli present? -------------------------------------------------
  step('1. lark-cli');
  let larkPresent = await isLarkCliAvailable();

  if (larkPresent) {
    ok('lark-cli is installed');
  } else {
    miss('lark-cli is not installed');

    if (checkOnly) {
      console.log(`\n  Install it with:  npm install -g ${LARK_PACKAGE}`);
      process.exit(1);
    }

    if (!commandExists('npm')) {
      bad('npm is not available, so it cannot be installed automatically');
      console.log('\n  lark-cli is distributed on npm, which needs Node.js.');
      console.log('  Install Node.js (https://nodejs.org), then run:');
      console.log(`    npm install -g ${LARK_PACKAGE}`);
      console.log('  and rerun: cfbrain feishu setup');
      process.exit(1);
    }

    const agreed = autoYes || (await confirm(`\n  Install ${LARK_PACKAGE} globally via npm now?`));
    if (!agreed) {
      console.log('\n  Skipped. To do it yourself later:');
      console.log(`    npm install -g ${LARK_PACKAGE}`);
      console.log('    cfbrain feishu setup');
      process.exit(canPrompt() ? 0 : 1);
    }

    console.log(`\n  Running: npm install -g ${LARK_PACKAGE}\n`);
    let installed = await runInteractive(['npm', 'install', '-g', LARK_PACKAGE]);

    if (!installed) {
      console.log('');
      bad('npm install failed');
      console.log('\n  This is usually a permissions problem with the global npm prefix.');
      console.log('  Options:');
      console.log(`    sudo npm install -g ${LARK_PACKAGE}`);
      console.log('    # or point npm somewhere you own:');
      console.log('    npm config set prefix ~/.npm-global');
      console.log('    export PATH=~/.npm-global/bin:$PATH');
      process.exit(1);
    }

    larkPresent = await isLarkCliAvailable();
    if (!larkPresent) {
      bad('installed, but lark-cli is still not on PATH');
      console.log('\n  Add your npm global bin directory to PATH, then rerun this command.');
      console.log('    npm bin -g        # shows the directory');
      process.exit(1);
    }
    ok('lark-cli installed');
  }

  // ---- 2. configured? -------------------------------------------------------
  step('2. Feishu app configuration');
  let status = await readAuthStatus();

  if (!status.configured) {
    miss('lark-cli has no Feishu app configured yet');
    console.log('\n  This links lark-cli to a Feishu app on YOUR tenant. It opens a');
    console.log('  verification URL in your browser.');

    if (checkOnly) process.exit(1);

    const agreed = autoYes || (await confirm('\n  Run `lark-cli config init --new` now?'));
    if (!agreed) {
      console.log('\n  Skipped. Run it yourself, then rerun: cfbrain feishu setup');
      process.exit(0);
    }
    console.log('');
    await runInteractive(['lark-cli', 'config', 'init', '--new']);
    status = await readAuthStatus();
    if (!status.configured) {
      bad('still not configured');
      console.log('\n  Rerun: cfbrain feishu setup');
      process.exit(1);
    }
  }
  ok(`configured${status.appId ? ` (app ${status.appId})` : ''}`);

  // ---- 3. logged in? --------------------------------------------------------
  step('3. Authorisation');
  if (status.userReady) {
    ok(`logged in${status.userName ? ` as ${status.userName}` : ''}`);
  } else {
    miss('no usable user authorisation');
    console.log('\n  A user login is needed to create and write wiki pages.');

    if (checkOnly) process.exit(1);

    const agreed = autoYes || (await confirm('\n  Run `lark-cli auth login` now?'));
    if (!agreed) {
      console.log('\n  Skipped. Run it yourself, then rerun: cfbrain feishu setup');
      process.exit(0);
    }
    console.log('');
    await runInteractive(['lark-cli', 'auth', 'login']);
    status = await readAuthStatus();
    if (!status.userReady) {
      bad('still not authorised');
      process.exit(1);
    }
    ok('authorised');
  }

  // ---- Done -----------------------------------------------------------------
  step('Ready');
  console.log('  Feishu prerequisites are satisfied. Next, pick a wiki space:\n');
  console.log('    cfbrain feishu init --create-space "My Brain"   # create a new one');
  console.log('        (needs one extra grant: lark-cli auth login --scope "wiki:space:write_only")');
  console.log('');
  console.log('    cfbrain feishu init --space-id <id>             # use one you already made');
  console.log('        (no extra permission needed)');
  console.log('');
  console.log('  Tip: define your categories BEFORE feishu init, so the wiki folders');
  console.log('  are created correctly the first time:');
  console.log('    cfbrain types add <type> --label "<Label>"');
  console.log('    cfbrain types remove <unwanted>');
}
