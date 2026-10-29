#!/usr/bin/env bash
# Mutationstest: baut absichtlich Sicherheits-/Logikfehler ein. Jeder muss von den Tests erkannt werden.
# Ausführen: bash tests/mutation.sh
# Alles in main(): Bash liest Skripte sonst zeilenweise nach – Änderungen während des Laufs
# würden ihn verfälschen.
main() {
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
missed=0; total=0
mut() { # $1 Name, $2 Datei, $3 alt, $4 neu
  total=$((total+1))
  rm -rf "$WORK/x" && mkdir -p "$WORK/x" && cp -r "$ROOT/tests" "$ROOT/tools" "$ROOT/manifest.json" "$ROOT/_locales" "$ROOT"/*.html "$ROOT"/*.js "$ROOT"/*.css "$ROOT/icons" "$WORK/x/"
  if ! python3 - "$WORK/x/$2" "$3" "$4" <<'PY'
import sys
p,a,b=sys.argv[1:4]; s=open(p).read()
if a not in s: sys.exit(3)
open(p,'w').write(s.replace(a,b,1))
PY
  then echo "  ?? Muster nicht gefunden: $1"; missed=$((missed+1)); return; fi
  out=$(cd "$WORK/x" && timeout 200 node --test tests/core.test.js tests/features.test.js tests/background.test.js tests/background-features.test.js tests/i18n.test.js 2>&1)
  code=$?
  fails=$(echo "$out" | grep -E "^# fail" | awk '{print $3}')
  if [ "$code" -ne 0 ] || [ "${fails:-0}" -gt 0 ]; then echo "  ✔ erkannt: $1 (${fails:-Abbruch} rot)"; else echo "  ✘ NICHT erkannt: $1"; missed=$((missed+1)); fi
}
mut "Absenderprüfung ausgehebelt" background.js "return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_BASE);" "return true;"
mut "Fremde Erweiterungen zugelassen" background.js "if (!sender || sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;" "if (!msg || typeof msg !== 'object') return false;"
mut "YouTube bekommt alle Daten" core.js "  const publicView = (s) => ({
    yt: clone(s.yt)," "  const publicView = (s) => ({
    all: clone(s),
    yt: clone(s.yt),"
mut "Uhr-Rücksprung-Schutz entfernt" core.js "return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;" "return !(maxSeen >= s.lockUntil);"
mut "NTP-Toleranz entfernt" core.js "return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;" "return true;"
mut "Serielle Warteschlange entfernt" background.js "const run = chain.then(fn);" "const run = Promise.resolve().then(fn);"
mut "Lockern während Sperre erlaubt (remove)" core.js "if (prot && op.list !== 'allowedChannels') return deny();" ""
mut "Lockern während Sperre erlaubt (setYt)" core.js "if (prot && s.yt[op.key] && !op.value) return deny();" ""
mut "Lockern während Sperre erlaubt (Modus)" core.js "if (prot && s.filter.mode === 'whitelist' && op.mode === 'blacklist') return deny();" ""
mut "Sperre verkürzbar" core.js "s.lockUntil = Math.max(s.lockUntil, start + Math.floor(ms));" "s.lockUntil = start + Math.floor(ms);"
mut "Import umgeht Sperre" core.js "const out = prot ? enforceLock(s, incoming) : incoming;" "const out = incoming;"
mut "Speicherzugriff nicht eingeschränkt" background.js "setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })" "setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })"
mut "Snapshot-Wiederherstellung entfernt" background.js "stored.snap = FG.withDefaults(changes._lockSnapshot.oldValue);" ""
mut "Listen-Whitelist umgangen (__proto__)" core.js "if (!has(LISTS, op.list) ||" "if ("
mut "Mengenbegrenzung entfernt" core.js "op.values.length > LIMITS.MAX_OP_VALUES" "false"
mut "Sperrdauer unbegrenzt" core.js "ms > LIMITS.MAX_LOCK_MS" "false"
mut "DNR-Diff entfernt" background.js "if (!FG.sameJSON(existing, want)) {" "if (true) {"
mut "Reihenfolge-abhängiger Vergleich (v1-Bug)" core.js "const sameJSON = (a, b) => stableStringify(a) === stableStringify(b);" "const sameJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);"
mut "Broadcast nach Neustart verschluckt" background.js "if (lastBroadcast === null && !prevKnown) return;" "if (lastBroadcast === null && !prevKnown) { lastBroadcast = key; return; }"
mut "Broadcast-Vergleich gegen falschen Vorzustand" background.js "const before = lastBroadcast !== null ? lastBroadcast : FG.stableStringify(FG.publicView(prev));" "const before = lastBroadcast !== null ? lastBroadcast : key;"
mut "Domain-Validierung entfernt" core.js "return /^(?=.{1,253}\$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9-]{2,63}\$/.test(s) ? s : '';" "return s;"

# --- 1.2: Zeitfreigabe, Partner-Code, Fokus, Zeitplan, YouTube-Limit ---
mut "Wartezeit nicht erzwungen" core.js "if (now < st.pending[d]) return fail('wait', { readyAt: st.pending[d] });" ""
mut "Abtipp-Satz nicht geprüft" core.js "if (!phraseMatches(op.phrase, settings.unlock.phrase)) return fail('phrase');" ""
mut "Tageskontingent ignoriert" core.js "        if (left(d) <= 0) return fail('quota');
        if (!phraseMatches" "        if (!phraseMatches"
mut "Freigabe per Uhr-Rückstellen verlängerbar" core.js "if (until - now > minutes * MIN + MIN) return false;" ""
mut "Kontingent-Tag folgt verstellter Uhr" core.js "const today = dayKey(seen);" "const today = dayKey(now);"
mut "Fokus verhindert keine Freigabe" core.js "        if (b.focus) return fail('focus');
        if (!b.blocked.includes(d)) return fail('notBlocked');
        if (left(d) <= 0) return fail('quota');" "        if (!b.blocked.includes(d)) return fail('notBlocked');
        if (left(d) <= 0) return fail('quota');"
mut "Partner-Code schützt Befehle nicht" core.js "const prot = timeLocked || (s.partner.enabled && !authorized);" "const prot = timeLocked;"
mut "Partner-Schutz repariert keine Manipulation" core.js "    else if (!authorized && partnerOn(snap)) base = snap;" ""
mut "Partner-Snapshot nach Deaktivierung aktiv" core.js "else if (snap) snapshot = Object.assign(clone(snap), { partner: clone(DEFAULTS.partner) });" "else if (snap) snapshot = clone(snap);"
mut "Hash erreicht die Oberfläche" core.js "const uiView = (s) => Object.assign(clone(s), { partner: { enabled: s.partner.enabled } });" "const uiView = (s) => clone(s);"
mut "Import setzt Partner-Code" core.js "incoming.partner = clone(s.partner); // … und nie den Partner-Code" ""
mut "Zeitplan unter Sperre änderbar" core.js "if (prot && s.features.schedule) return deny();" ""
mut "enforceLock: Zeitplan einschaltbar" core.js "if (!snap.features.schedule) out.features.schedule = false;" ""
mut "Zustands-Manipulation setzt Zähler zurück" core.js "for (const d of Object.keys(i.used)) out.used[d] = Math.max(t.used[d] || 0, i.used[d]);" "out.used = i.used;"
mut "YouTube-Tick unbegrenzt" core.js "const ms = Math.min(Math.floor(op.ms), LIMITS.YT_TICK_MAX_MS);" "const ms = Math.floor(op.ms);"
mut "Initiator-Regel fehlt (offene Tabs laden weiter)" core.js "    if (blocked.length) {
      // Offene Tabs" "    if (false) {
      // Offene Tabs"
mut "Partner-Code: jeder Code gilt" background.js "const valid = typeof code === 'string'" "const valid = true || typeof code === 'string'"
mut "Partner-Code: keine Ratenbegrenzung" background.js "if (stored.pf.until > now) return { ok: false, error: 'cooldown', retryAt: stored.pf.until };" ""
mut "Interner Befehl partnerStore von außen aufrufbar" background.js "'partnerSet', 'partnerDisable']);" "'partnerSet', 'partnerDisable', 'partnerStore']);"
mut "YouTube-Tick ohne Zeitprüfung pro Tab" background.js "const ms = Math.min(msg.ms, since, FG.LIMITS.YT_TICK_MAX_MS);" "const ms = Math.min(msg.ms, FG.LIMITS.YT_TICK_MAX_MS);"
mut "YouTube-Ticks von beliebigem Absender" background.js "if (!isYouTubeContent(sender)) {" "if (false) {"
mut "Host-Rechte werden nicht aufgeräumt" background.js "if (drop.length) await chrome.permissions.remove({ origins: drop });" ""

mut "Übersetzung fehlt (Schlüssel gelöscht)" tools/messages.js "  unlockBtn: ['Unlock', 'Freigeben']," ""
mut "Platzhalter in einer Sprache vergessen" tools/messages.js "unlocksLeft: ['\$1 of \$2 unlocks left today.'," "unlocksLeft: ['\$1 unlocks left today.',"
mut "Neuinstallation ohne Sprach-Satz" background.js "settings: raw.settings ? FG.withDefaults(raw.settings) : freshDefaults()," "settings: FG.withDefaults(raw.settings),"

# Mutationen, die der statische Scanner finden muss
smut() { # $1 Name, $2 Datei, $3 alt, $4 neu
  total=$((total+1))
  rm -rf "$WORK/s" && mkdir -p "$WORK/s" && (cd "$ROOT" && cp -r manifest.json *.js *.html *.css icons tests tools _locales "$WORK/s/")
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
smut "innerHTML in Optionen" options.js "$(ulId).replaceChildren(frag);" "$(ulId).innerHTML = items.join('');"
smut "fetch im Hintergrund" background.js "const TICK = 'fg-tick';" "const TICK = 'fg-tick'; fetch('https://tracker.example/x');"
smut "storage.sync verwendet" background.js "const raw = await chrome.storage.local.get(" "const raw = await chrome.storage.sync.get("
smut "Host-Rechte für alle Seiten" manifest.json '"permissions": [' '"host_permissions": ["<all_urls>"], "permissions": ['
smut "Inline-Skript im Popup" popup.html '<script src="popup.js"></script>' '<script>alert(1)</script>'
smut "Rechtschreibprüfung wieder an" options.html 'id="siteInput" type="text" data-i18n-placeholder="sitesPlaceholder" data-i18n-aria-label="sitesAddAria" autocomplete="off" spellcheck="false"' 'id="siteInput" type="text" data-i18n-placeholder="sitesPlaceholder" data-i18n-aria-label="sitesAddAria" autocomplete="off"'

smut "background.scripts im Chromium-Manifest (1.1-Bug)" manifest.json '"service_worker": "background.js",' '"service_worker": "background.js", "scripts": ["background.js"],'
smut "web_accessible_resources eingeführt" manifest.json '"permissions": [' '"web_accessible_resources": [{"resources": ["blocked.html"], "matches": ["<all_urls>"]}], "permissions": ['
smut "Optionale Host-Rechte erweitert" manifest.json '"optional_host_permissions": [' '"optional_permissions": ["tabs"], "optional_host_permissions": ['

echo; echo "Ergebnis: $((total-missed))/$total Mutationen erkannt"
[ "$missed" -eq 0 ]
}
main "$@"
exit $?
