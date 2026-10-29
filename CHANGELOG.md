# Changelog

## 1.3.0 – 29 Oct 2026

### New
- **English and German.** The interface follows the browser's language; English is the fallback. All texts live in one catalog (`tools/messages.js`), `_locales/` is generated from it.
- **New interface in the style of macOS System Settings:** sidebar with sections, grouped lists, switches, segmented controls, a Control Center–like popup; light and dark mode follow the system.
- **New logo:** Odysseus' ship on a night sea – the sirens' song breaks off before the sail. A simplified version keeps it legible at 16 px.
- Block page and YouTube block screen in the brand's night-sea look.
- New installs get the typing sentence in the browser's language.

### Repository
- `SECURITY.md` is now a vulnerability-reporting policy; the review moved to `AUDIT.md` (English).
- README and privacy policy in English, German versions in `README.de.md` and `PRIVACY.de.md`.

### Tests
- New: translation tests (catalog in sync, no missing or dead keys, same placeholders, no hard-coded UI text) and a browser language test in English and German.
- Fixed before release, found by the review: the YouTube script failed to start (translation helper used before definition); a start-up race created English defaults on German browsers.

## 1.2.1 – 29 Oct 2026
- **Renamed to Sirenward** (formerly FocusGuard – the name was taken on addons.mozilla.org).
- Unique Firefox add-on ID for addons.mozilla.org.
- Settings, behaviour and storage format unchanged; FocusGuard exports can still be imported.

## 1.2.0 – 27 Oct 2026
- **Timed unlock:** unlock a blocked site for e.g. 15 minutes; daily limit per site; waiting time plus typing a sentence (letters only, case-insensitive, no pasting); open tabs stop loading when it ends.
- **Optional extras:** schedule, focus session, custom block page, partner code, YouTube daily limit, local statistics; YouTube: hide search suggestions and trending, grayscale thumbnails.
- **Fixed:** Chrome/Brave reported `'background.scripts' requires manifest version of 2 or lower` – there are now separate Chromium and Firefox packages.
- **Security:** waiting time, sentence, quota and focus are enforced in the background; clock tricks can't extend unlocks or reset the quota; partner code stored only as a PBKDF2 hash with rate limiting; outside changes to the runtime state are accepted only where they don't loosen; host access for the block page only per blocked domain and revoked automatically.
- Found during development: an authorized change (partner code) was reverted by the extension's own storage echo – fixed with a regression test.

## 1.1.0 – 27 Oct 2026
- **Fixed lost updates:** quick actions in popup and settings overwrote each other (20 concurrent changes → 1 saved).
- **No more flashing:** blocked videos were visible briefly (560 of 1,602); now none.
- **Strict mode:** videos from other channels no longer play while the channel is being checked.
- **Security:** Trusted Types; protection against clock manipulation; the YouTube script has no storage access and only gets a read-only view; single writer with sender and schema checks; reproducible build.
- **Architecture and speed:** functional core / imperative shell; incremental YouTube script (−70 % script time while scrolling, −85 % during playback); accessible block screen.

## 1.0.0 – 27 Oct 2026
First version (as FocusGuard).
