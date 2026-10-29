<p align="center"><img src="assets/icon-512.png" width="112" alt="Sirenward icon: a sailing boat on a night sea, the sirens' song breaking off before the sail"></p>

<h1 align="center">Sirenward</h1>

<p align="center"><em>Like Odysseus at the mast: commit in advance and sail past the sirens.</em></p>

<p align="center"><a href="README.de.md">Deutsch</a> · <a href="PRIVACY.md">Privacy</a> · <a href="AUDIT.md">Security audit</a> · <a href="SECURITY.md">Report a vulnerability</a></p>

Sirenward is an open-source browser extension against digital distraction. It combines **site blocking**, a calmer **YouTube** (like Unhook), **channel and keyword filters** (like BlockTube) and a **lock mode** you can't simply switch off on a whim.

**Privacy first:** no servers, no accounts, no tracking, no history. The extension has no technical way to send data – its content security policy forbids every network connection.

Works in Chrome, Brave, Edge, Vivaldi and Opera (version 120+) and Firefox (128+). The interface is available in **English and German** and follows your browser's language.

## Features

**Block websites**
- Block domains including all subdomains – one click in the popup blocks the current site.
- The block lives inside the browser, so it **also works with a VPN, a different DNS or DNS over HTTPS** – unlike a router block.

**Timed unlock**
- Unlock a blocked site for, say, **15 minutes**; afterwards it locks itself again.
- **Daily limit per site** (default: 3 unlocks).
- **Deliberate friction:** first a waiting time, then type a sentence. Only the letters count, case doesn't matter, pasting is blocked.
- When an unlock ends, open tabs of that site stop loading anything.

**Calmer YouTube**
- Hide the home feed (or go straight to your subscriptions), recommendations, Shorts, comments, end cards, autoplay, search suggestions and trending; grayscale thumbnails.
- Block channels (by @handle, name or link) and keywords in titles – or **strict mode**: only channels you allow are visible and playable.
- Blocked videos are hidden before the first frame is drawn. Opening one directly shows a block screen and the video stays paused.

**Lock mode**
- From 1 hour to 30 days, rules can only be **tightened**, never loosened.
- Attempts to get around it are reverted automatically: editing or clearing storage, importing settings, moving the system clock forward or back.

**Optional extras** (off by default)
- **Schedule:** block only at set times, including overnight.
- **Focus session:** one click blocks your whole list and pauses unlocks.
- **Custom block page** with time left and an unlock button. Access is requested only for the blocked domains and revoked automatically.
- **Partner code:** someone else sets a code; without it nothing can be loosened.
- **YouTube daily limit** on actual watch time.
- **Local statistics:** daily counters only, no addresses, kept for 30 days.

## Install

Each release contains two packages with identical code – they differ only in the manifest:
- `sirenward-<version>-chromium.zip` – Chrome, Brave, Edge, Vivaldi, Opera
- `sirenward-<version>-firefox.zip` – Firefox

**Chrome, Brave, Edge:** unzip, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the folder. Recommended: allow the extension in incognito windows (extension details).

**Firefox:** install from [addons.mozilla.org](https://addons.mozilla.org/) once it's listed. For testing: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `manifest.json`. Afterwards allow access to `www.youtube.com` under *Add-ons → Sirenward → Permissions* and enable *Run in private windows*.

**Verify a download:** the build is reproducible. Rebuilding from the tagged source gives bit-identical ZIPs:
```bash
node tools/build.js          # writes dist/ and dist/SHA256SUMS
sha256sum -c dist/SHA256SUMS
```

## Honest limits

A browser extension can always be disabled or removed, and other browsers aren't covered. Lock mode makes switching it off on impulse much harder, not impossible. For more strength, combine Sirenward with a router block, or let someone else install it through a browser policy. YouTube changes its markup from time to time; the selectors live in `content.js` and `content.css`, and strict mode blocks when in doubt.

## Architecture

```
 Popup / settings / block page ──command──▶ background.js ──writes──▶ storage.local
         (client.js, i18n.js)    ◀─reply──   (single writer,           │
                                              serial queue)            ├─▶ declarativeNetRequest (site block)
                                                  │                    └─▶ lock snapshot + clock watch
                                                  │ read-only view (YouTube options only)
                                                  ▼
                                             content.js (YouTube, isolated world, NO storage access)
                       every decision: core.js (pure functions, no I/O, fully testable in Node)
```

| File | Purpose |
|---|---|
| `core.js` | Functional core: validation, filters, commands, lock policy, schedule, unlocks, blocking rules |
| `background.js` | Imperative shell (ES module): single writer, sender checks, site blocking, tamper protection |
| `client.js`, `i18n.js` | Command API and translations for the extension pages |
| `unlock-ui.js` | Unlock widget (waiting time + typing) for popup and block page |
| `options.*`, `popup.*`, `blocked.*`, `ui.css` | Interface in the style of macOS System Settings, light and dark |
| `content.js`, `content.css` | YouTube: filtering before first paint, video gate, block screen |
| `tools/messages.js` | All texts in English and German – `_locales/` is generated from it |
| `tools/` | Reproducible build for Chromium and Firefox |
| `tests/` | Unit, background, translation, mutation, browser and security tests; benchmark |

## Development

```bash
npm test                # unit + background + translation tests, static security scan
npm run test:mutation   # deliberately broken copies – every one must be caught
npm run test:e2e        # real Chromium: features, languages, block page, CSP probe, network capture
npm run verify          # everything, against the built package
node tools/i18n.js      # regenerate _locales/ after editing tools/messages.js
```
Requires Node 20+, the npm packages `typescript` and `playwright` (with Chromium), `openssl`, `zip`, and free ports 80/443 for the browser tests.

## License

[MIT](LICENSE)
