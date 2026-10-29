# Security, architecture and privacy audit – SirenWard 1.3.0

Date: 29 Oct 2026 · Scope: complete source (no third-party code at runtime) and the built Chromium and Firefox packages.
To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Summary

| Check | Result |
|---|---|
| Network requests made by the extension (real browser, every host captured) | **0** |
| Static security and architecture scan (repo and both packages) | **0 critical** |
| Unit, background and translation tests (fuzzing, randomized tests, clock attacks, concurrency, partner code) | **72/72** |
| Mutation tests (deliberately broken copies) | **60/60 caught** |
| Browser checks in Chromium against the **built package** | **78/78** |
| Language checks (English and German, incl. YouTube) | **20/20** |
| Custom block page (redirect, unlock, automatic re-lock) | **8/8** |
| `chrome://extensions`: manifest errors, warnings, runtime errors | **none** |
| CSP probe with real extension code (eval, Function, innerHTML, foreign scripts, fetch) | **all blocked** |
| Build | reproducible (bit-identical ZIPs), only referenced runtime files |

## 1. Attack surface

**Permissions:** `storage`, `declarativeNetRequest`, `activeTab`, `alarms`. **No** permanent `host_permissions`, no `tabs`, `history`, `webRequest`, `cookies` or `scripting`. Optional, only for the custom block page: access to individual **blocked** domains (`optional_host_permissions` is just the upper bound; access is requested per domain and revoked automatically). The content script runs only on `https://www.youtube.com/*`, in the isolated world, not in frames.

**Not reachable from outside:** no `externally_connectable`, no `web_accessible_resources` (web pages can neither detect nor address the extension), no `onMessageExternal`. Messages from other extensions are ignored.

**Trust boundaries:**

| Context | May |
|---|---|
| Popup, settings, block page (own pages) | read settings (without the partner hash); change things only by sending a **command** to the background. Internal commands (e.g. `partnerStore`) can't be called |
| YouTube content script (runs inside a third-party page's process) | receive a **read-only view** (YouTube options, filter, limit). No storage access (`setAccessLevel: TRUSTED_CONTEXTS`), no website list, no commands. May report watch time – capped at the time that actually passed, per tab |
| Background | single writer; checks sender, schema, size, lock mode and partner code |

**Content security policy** of all extension pages:
```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none';
object-src 'none'; form-action 'none'; base-uri 'none';
require-trusted-types-for 'script'; trusted-types 'none'
```
No connections, no outside resources, no `eval`. Trusted Types additionally lock every HTML and script injection sink (`innerHTML`, string timers, script elements), so a future coding mistake can't open an XSS hole.

## 2. Threat model of the commitment features

| Attack | Defence | Covered by |
|---|---|---|
| Skip waiting time / typing via DevTools | the **background** enforces waiting time, sentence, quota and focus; request and confirmation are separate steps | unit + browser ("background enforces the waiting time") |
| Set the clock back to extend an unlock | remaining time is never longer than the unlock length; clock jumps are detected | unit (incl. deleted clock value) + mutation |
| Change the clock to get a new daily quota | the day is the latest day ever seen | unit + mutation |
| Reset counters / unlocks / focus in storage | outside changes to the state are only accepted where they don't loosen | unit + background + mutation |
| Move the clock forward → delete rules → move it back | lock re-arms automatically; snapshot is kept and restored if deleted | background + mutation |
| Guess the partner code | PBKDF2-SHA-256, 600,000 rounds; rate limit from the 5th failed attempt (5 → 60 min); constant-time comparison | background + mutation |
| Read the partner code | only the hash is stored; never sent to the UI, never exported | background + browser |
| Switch off partner protection by editing storage | the snapshot is authoritative and repairs it | background + browser |
| Fake YouTube watch time (compromised page process) | accepted only from the YouTube content script, capped per tab and at 30 s per report; over-reporting only makes things stricter | background + mutation |
| Abuse the block page (clickjacking, detecting the extension) | no `web_accessible_resources`; refuses to render in a frame; only domains on the block list | browser |
| Overly broad host access | only per blocked domain, revoked automatically; the scanner forbids other optional permissions | background + mutation + scanner |

**Honest limit:** schedule and focus follow the system clock. Moving the clock forward permanently ends focus and time windows early. A changed clock never extends an unlock, never yields a new quota and never lifts lock mode for good.

## 3. New in 1.3: languages, interface, logo

- **English and German** via `chrome.i18n`. All texts live in one catalog (`tools/messages.js`); `_locales/` is generated from it. Tests make sure the files are in sync, every key used in the code exists, there are no dead keys, both languages use the same placeholders, and no hard-coded German UI text is left in the code.
- New installs get the typing sentence in the browser's language; existing settings are never overwritten.
- **Interface in the style of macOS System Settings** (sidebar, grouped lists, switches, segmented controls; light and dark). It uses only the system font and inline SVG symbols – no outside fonts or images, CSP unchanged.
- Translated texts are only ever set with `textContent` or attributes; the YouTube home hint is passed as a CSS custom property through the CSSOM, which the page's CSP doesn't affect.

**Found and fixed while building 1.3** (never released): the YouTube script used its translation helper before it was defined, so the whole script failed to start – caught in the visual review and now covered by the language test. A start-up race created English defaults before the browser language was applied – fixed; covered by a background test and a mutation.

## 4. Methods

**Static scan (`tests/static-scan.js`)** – AST-based (TypeScript parser). It derives the runtime files from the manifest (same source as the build) and checks network APIs, code execution, HTML sinks, risky APIs, outside resources, inline code, permissions, CSP incl. Trusted Types – and architecture rules: only `background.js` writes to storage, `content.js` never touches storage, no `importScripts`, no `storage.sync`, no `background.scripts` in the Chromium manifest, inputs without spell-check, packages contain only referenced files. Result: 0 critical. The remaining hints were reviewed: one static import of `./core.js`, fixed relative YouTube navigations, `https://` + a validated block-list domain, a `blob:` URL for the local export, local IDN parsing in `normalizeDomain`, and the optional host-permission upper bound.

**Unit and background tests** – `core.js` is pure and tested directly. `background.js` runs against a faithful browser stand-in (`tests/lib/fake-chrome.js`: sorted storage keys like Chrome, async `onChanged`, alarms, permissions, `i18n`). Covered among others: sender checks, 50 concurrent commands without a lost update, every way of loosening during a lock, clock attacks, storage tampering, partner code incl. rate limit, 3,000 randomized lock-policy runs (always a fixed point, never looser than an active lock), prototype pollution, ReDoS with 200,000-character inputs.

**Mutation tests (`tests/mutation.sh`)** – each run deliberately breaks one thing (sender check, clock protection, quota, partner hash exposure, a missing translation, a lost placeholder, CSP relaxed, `fetch` added, `<all_urls>` …). Every mutation must turn a test red. Result: **60/60 caught**.

**Browser test with network capture (`tests/e2e.test.js`)** – the built package in real Chromium; every hostname is redirected to logging local servers; a control run without the extension measures Chromium's own traffic; YouTube is replicated incl. crafted XSS titles. Covers site blocking (the blocked domain never reaches a server), concurrency, focus retention, 0 of 202 blocked videos visible on first paint, block screen with paused video and inert page, strict mode, timed unlock end-to-end, schedule, partner code dialog, focus, daily limit, statistics, four tampering attempts during lock mode, XSS, isolation, **0 requests by the extension**, no JS/CSP errors and a clean `chrome://extensions`.

**Language test (`tests/locale.test.js`)** – runs Chromium in English and German and checks the chosen language, that no raw keys are visible, the fresh-install sentence, dynamically built rows, popup, block page and the YouTube screens.

**CSP probe (`tests/csp-probe.test.js`)** – a real extension page tries `eval`, indirect `eval`, `new Function`, `setTimeout(string)`, `innerHTML`, a foreign script and `fetch`. Everything is blocked; no request reaches a server.

## 5. History of findings

| Version | Finding | Status |
|---|---|---|
| 1.0 → 1.1 | Lost updates on quick actions (20 concurrent changes → 1 saved) | fixed: single writer + queue |
| 1.0 → 1.1 | Lock mode could be bypassed by moving the clock forward | fixed: clock-jump detection |
| 1.0 → 1.1 | Blocked videos flashed (560 of 1,602 visible) | fixed: 0 |
| 1.0 → 1.1 | Strict mode: other channels' videos played for up to 4 s | fixed: fail-closed video gate |
| 1.0 → 1.1 | YouTube script could write all settings; no sender or schema checks | fixed |
| 1.2 | `background.scripts` next to `service_worker` → manifest error in Chromium browsers | fixed: separate packages, scanner rule, `chrome://extensions` check |
| 1.2 | An authorized loosening (partner code) was reverted by the extension's own storage echo | fixed: echo detection; regression test |
| 1.3 | YouTube script crashed at start (translation helper used before definition) | fixed before release; language test |
| 1.3 | Start-up race: English defaults on a German browser | fixed before release; test + mutation |

## 6. Performance (Chromium, median of 5 runs, added script time vs. no extension)

| Scenario | 1.0 | 1.1 → 1.3 |
|---|---|---|
| Infinite scroll (30 × 40 videos, like YouTube) | 308 ms | **~85–92 ms** |
| 8 s of video playback | 77 ms | **≤ 12 ms** |
| Blocked videos visible on first paint | 560 / 1,602 | **0 / 1,602** |

## 7. Residual risks

| Risk | Assessment |
|---|---|
| Self-bypass: disable/remove the extension, use another browser | inherent; mitigations: router block, allow in incognito, browser policy set by someone else |
| Leaving the system clock wrong permanently | while wrong, a lock appears expired; it re-arms once the clock is corrected. A wrong clock breaks many websites anyway |
| YouTube detecting hidden elements | applies to every page-changing extension; no data is transmitted |
| YouTube changing its markup | hiding may partly stop working; strict mode blocks when in doubt |
| Firefox lacks `setAccessLevel` | the YouTube script never uses storage anyway (enforced by the scanner) |

## 8. Not performed

- **ESLint security plugins and Mozilla's `web-ext lint`** – the npm registry was blocked in the review environment. Replaced by the custom AST scanner (itself checked by mutations). Recommended: `npx web-ext lint -s dist/firefox`.
- **Runtime test in Firefox** – only Chromium was available.
- **Test against the real YouTube** – no internet access; a replica was used.

## Reproduce

```bash
npm run verify
```
