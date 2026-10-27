#!/usr/bin/env bash
# Mutationstest: baut absichtlich Sicherheits-/Logikfehler ein. Jeder muss von den Tests erkannt werden.
# Ausführen: bash tests/mutation.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
missed=0; total=0
mut() { # $1 Name, $2 Datei, $3 alt, $4 neu
  total=$((total+1))
  rm -rf "$WORK/x" && mkdir -p "$WORK/x" && cp -r "$ROOT/core.js" "$ROOT/background.js" "$ROOT/tests" "$WORK/x/"
  if ! python3 - "$WORK/x/$2" "$3" "$4" <<'PY'
import sys
p,a,b=sys.argv[1:4]; s=open(p).read()
if a not in s: sys.exit(3)
open(p,'w').write(s.replace(a,b,1))
PY
  then echo "  ?? Muster nicht gefunden: $1"; missed=$((missed+1)); return; fi
  out=$(cd "$WORK/x" && timeout 90 node --test tests/core.test.js tests/background.test.js 2>&1)
  code=$?
  fails=$(echo "$out" | grep -E "^# fail" | awk '{print $3}')
  if [ "$code" -ne 0 ] || [ "${fails:-0}" -gt 0 ]; then echo "  ✔ erkannt: $1 (${fails:-Abbruch} rot)"; else echo "  ✘ NICHT erkannt: $1"; missed=$((missed+1)); fi
}
mut "Absenderprüfung ausgehebelt" background.js "return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_BASE);" "return true;"
mut "Fremde Erweiterungen zugelassen" background.js "if (!sender || sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;" "if (!msg || typeof msg !== 'object') return false;"
mut "YouTube bekommt alle Daten" core.js "const publicView = (s) => ({ yt: clone(s.yt), filter: clone(s.filter) });" "const publicView = (s) => clone(s);"
mut "Uhr-Rücksprung-Schutz entfernt" core.js "return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;" "return !(maxSeen >= s.lockUntil);"
mut "NTP-Toleranz entfernt" core.js "return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;" "return true;"
mut "Serielle Warteschlange entfernt" background.js "const run = chain.then(fn);" "const run = Promise.resolve().then(fn);"
mut "Lockern während Sperre erlaubt (remove)" core.js "if (locked && op.list !== 'allowedChannels') return fail('locked');" ""
mut "Lockern während Sperre erlaubt (setYt)" core.js "if (locked && s.yt[op.key] && !op.value) return fail('locked');" ""
mut "Lockern während Sperre erlaubt (Modus)" core.js "if (locked && s.filter.mode === 'whitelist' && op.mode === 'blacklist') return fail('locked');" ""
mut "Sperre verkürzbar" core.js "s.lockUntil = Math.max(s.lockUntil, start + Math.floor(ms));" "s.lockUntil = start + Math.floor(ms);"
mut "Import umgeht Sperre" core.js "const out = locked ? enforceLock(s, incoming) : incoming;" "const out = incoming;"
mut "Speicherzugriff nicht eingeschränkt" background.js "setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })" "setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })"
mut "Snapshot-Wiederherstellung entfernt" background.js "stored.snap = FG.withDefaults(changes._lockSnapshot.oldValue);" ""
mut "Listen-Whitelist umgangen (__proto__)" core.js "if (!has(LISTS, op.list) ||" "if ("
mut "Mengenbegrenzung entfernt" core.js "op.values.length > LIMITS.MAX_OP_VALUES" "false"
mut "Sperrdauer unbegrenzt" core.js "ms > LIMITS.MAX_LOCK_MS" "false"
mut "DNR-Diff entfernt" background.js "if (current && FG.sameJSON(current, sites)) return; // nichts zu tun" ""
mut "Reihenfolge-abhängiger Vergleich (v1-Bug)" core.js "const sameJSON = (a, b) => stableStringify(a) === stableStringify(b);" "const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);"
mut "Broadcast nach Neustart verschluckt" background.js "if (lastBroadcast === null && !prevKnown) return;" "if (lastBroadcast === null && !prevKnown) { lastBroadcast = key; return; }"
mut "Broadcast-Vergleich gegen falschen Vorzustand" background.js "const before = lastBroadcast !== null ? lastBroadcast : FG.stableStringify(FG.publicView(prev));" "const before = lastBroadcast !== null ? lastBroadcast : key;"
mut "Domain-Validierung entfernt" core.js "return /^(?=.{1,253}\$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9-]{2,63}\$/.test(s) ? s : '';" "return s;"

# Mutationen, die der statische Scanner finden muss
smut() { # $1 Name, $2 Datei, $3 alt, $4 neu
  total=$((total+1))
  rm -rf "$WORK/s" && mkdir -p "$WORK/s" && (cd "$ROOT" && cp -r manifest.json *.js *.html *.css icons tests "$WORK/s/")
  python3 - "$WORK/s/$2" "$3" "$4" <<'PY' || { echo "  ?? Muster nicht gefunden: $1"; missed=$((missed+1)); return; }
import sys
p,a,b=sys.argv[1:4]; s=open(p).read()
if a not in s: sys.exit(3)
open(p,'w').write(s.replace(a,b,1))
PY
  if (cd "$WORK/s" && node tests/static-scan.js >/dev/null 2>&1); then echo "  ✘ NICHT erkannt (Scanner): $1"; missed=$((missed+1)); else echo "  ✔ erkannt (Scanner): $1"; fi
}
smut "Seite schreibt direkt in den Speicher" options.js "async function run(op, okMsg) {" "async function run(op, okMsg) { chrome.storage.local.set({ settings: {} });"
smut "YouTube-Skript liest Speicher" content.js "let haveBroadcast = false;" "let haveBroadcast = false; chrome.storage.local.get('settings');"
smut "importScripts im Service Worker" background.js "import './core.js';" "importScripts('core.js');"
smut "Trusted Types aus CSP entfernt" manifest.json "; require-trusted-types-for 'script'; trusted-types 'none'" ""
smut "connect-src geöffnet" manifest.json "connect-src 'none'" "connect-src https:"
smut "innerHTML in Optionen" options.js "ul.replaceChildren(frag);" "ul.innerHTML = items.join('');"
smut "fetch im Hintergrund" background.js "const RULE_ID = 1;" "const RULE_ID = 1; fetch('https://tracker.example/x');"
smut "storage.sync verwendet" background.js "const raw = await chrome.storage.local.get(" "const raw = await chrome.storage.sync.get("
smut "Host-Rechte für alle Seiten" manifest.json '"permissions": [' '"host_permissions": ["<all_urls>"], "permissions": ['
smut "Inline-Skript im Popup" popup.html '<script src="popup.js"></script>' '<script>alert(1)</script>'
smut "Rechtschreibprüfung wieder an" options.html 'id="siteInput" type="text" placeholder="z. B. instagram.com, reddit.com" autocomplete="off" spellcheck="false"' 'id="siteInput" type="text" placeholder="x" autocomplete="off"'

echo; echo "Ergebnis: $((total-missed))/$total Mutationen erkannt"
[ "$missed" -eq 0 ]
