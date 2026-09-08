#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Standalone-binary verification
#
#   ./scripts/verify-binary.sh [path-to-binary]
#
# Proves the single-file binary is genuinely self-contained by running it in a
# hostile environment:
#   - copied to an empty directory (no source tree, no node_modules)
#   - `env -i` so there is no inherited PATH, no bun, no HOME
#   - a throwaway HOME so no existing brain or config can be reused
#   - the extension cache wiped first, so extraction is exercised from scratch
#
# Exits 0 only if every step passes.
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-$REPO_ROOT/bin/cfbrain}"

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -x "$BIN" ]; then
  echo "No binary at $BIN"
  echo "Build one first:  bun run build"
  exit 1
fi

ISO="$(mktemp -d "${TMPDIR:-/tmp}/cfbrain-iso-XXXXXX")"
FAKEHOME="$(mktemp -d "${TMPDIR:-/tmp}/cfbrain-isohome-XXXXXX")"
cleanup() { rm -rf "$ISO" "$FAKEHOME"; }
trap cleanup EXIT

cp "$BIN" "$ISO/cfbrain"
# Wipe the extension cache so tarball extraction is tested cold.
rm -rf "${TMPDIR:-/tmp}"/cfbrain-pglite-ext-* 2>/dev/null || true

# env -i = empty environment: no bun, no inherited PATH, no real HOME.
R() { env -i PATH=/usr/bin:/bin HOME="$FAKEHOME" "$ISO/cfbrain" "$@" 2>&1; }

echo "binary : $BIN ($(du -h "$BIN" | cut -f1))"
echo "isolated dir : $ISO  (contents: $(ls "$ISO" | tr '\n' ' '))"
echo "fake HOME    : $FAKEHOME"

step "1. runs at all"
if R --help | grep -q 'personal knowledge brain'; then ok "--help"; else bad "--help"; fi

step "2. creates a brain (needs pglite.wasm + pglite.data embedded)"
OUT="$(R init --pglite --non-interactive)"
if echo "$OUT" | grep -q 'Brain ready at'; then
  ok "init --pglite"
else
  bad "init --pglite" "$(echo "$OUT" | tail -3)"
fi

step "3. extensions load (needs vector.tar.gz + pg_trgm.tar.gz embedded)"
if echo "$OUT" | grep -qiE 'Extension bundle not found|is not available'; then
  bad "extension bundles" "$(echo "$OUT" | grep -iE 'Extension bundle|not available' | head -2)"
else
  ok "extension bundles (no load errors)"
fi

step "4. write / read round-trip"
printf -- '---\ntitle: Binary Verify\ntypes: [note]\n---\n\nWritten by the standalone binary. Links to [[something-else]].\n' > "$FAKEHOME/page.md"
if R put verify-page --content-file "$FAKEHOME/page.md" --no-embed | grep -q 'created_or_updated'; then
  ok "put"
else
  bad "put"
fi
if R get verify-page | grep -q 'Binary Verify'; then ok "get"; else bad "get"; fi
if R list | grep -q 'verify-page'; then ok "list"; else bad "list"; fi

step "5. keyword search (tsvector index working)"
if R search "Written" --no-embed | grep -q 'verify-page'; then ok "search"; else bad "search"; fi

step "6. graph"
if R repair --links | grep -qi 'Links created'; then ok "repair --links"; else bad "repair --links"; fi

step "7. health"
DOC="$(R doctor --json)"
if echo "$DOC" | grep -q '"status":"healthy"'; then
  ok "doctor reports healthy"
else
  bad "doctor" "$(echo "$DOC" | head -c 200)"
fi

step "8. MCP server answers (other agents can write)"
if command -v python3 >/dev/null 2>&1; then
  MCP="$(python3 - "$ISO/cfbrain" "$FAKEHOME" <<'PY'
import json,subprocess,sys,time,threading
binp,home=sys.argv[1],sys.argv[2]
try:
    p=subprocess.Popen([binp,'serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','HOME':home},text=True,bufsize=1)
except Exception as e:
    print("SPAWN_FAIL",e); raise SystemExit
out=[]; threading.Thread(target=lambda:[out.append(l.strip()) for l in p.stdout],daemon=True).start()
def send(o):
    p.stdin.write(json.dumps(o)+'\n'); p.stdin.flush()
try:
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}})
    time.sleep(4)
    send({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})
    send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    time.sleep(4)
    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"put_page","arguments":{
        "slug":"via-mcp","content":"---\ntitle: Via MCP\ntypes: [note]\n---\n\nok","no_embed":True}}})
    time.sleep(6)
except Exception as e:
    print("SEND_FAIL",e)
n=0; wrote=False
for l in out:
    try: d=json.loads(l)
    except: continue
    if d.get('id')==2: n=len(d.get('result',{}).get('tools',[]))
    if d.get('id')==3 and 'created_or_updated' in json.dumps(d): wrote=True
p.kill()
print(f"TOOLS={n} WROTE={wrote}")
PY
)"
  TOOLS="$(echo "$MCP" | grep -oE 'TOOLS=[0-9]+' | cut -d= -f2)"
  if [ "${TOOLS:-0}" -gt 0 ]; then ok "MCP tools/list ($TOOLS tools)"; else bad "MCP tools/list" "$MCP"; fi
  if echo "$MCP" | grep -q 'WROTE=True'; then ok "MCP put_page from external client"; else bad "MCP put_page" "$MCP"; fi
else
  printf '  \033[33mSKIP\033[0m  MCP checks (python3 not found)\n'
fi

step "Result"
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mThe binary is self-contained.\033[0m It ran with no bun, no source tree,\n'
  printf 'no node_modules and an empty environment.\n'
  exit 0
else
  printf '\033[31mThe binary is NOT self-contained.\033[0m See failures above.\n'
  exit 1
fi
