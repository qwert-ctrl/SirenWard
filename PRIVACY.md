# Privacy policy – SirenWard

[Deutsch](PRIVACY.de.md)

**In short: SirenWard doesn't collect, transmit or sell any data. Period.**

## What is stored

Only the settings you enter yourself: blocked websites, YouTube options, blocked or allowed channels, keywords and the end of an active lock. For lock mode, a copy of the rules at the start of the lock and the latest time seen are added – that's how SirenWard notices a changed system clock.

For timed unlocks, **today's** counters per blocked domain are stored, plus running unlocks and focus sessions. The counters reset automatically the next day. With the YouTube daily limit on, today's watch time is stored as **a single number** – no videos, no channels. **Statistics** are only collected if you turn them on: daily counters, no addresses, deleted after 30 days.

A **partner code** is never stored in plain text, only as a PBKDF2 hash (600,000 rounds, random salt), and it never leaves the device when exporting.

Everything lives in `storage.local` – only in your browser profile on this device. Deliberately **not** `storage.sync`, so nothing is synced through a Google or Mozilla account.

## What is not stored

- no browsing history, no visited pages, no watched videos
- no usage data beyond the counters above (statistics only when turned on)
- no identifiers, no cookies, no fingerprinting

## Network

SirenWard contains no code that makes network requests. On top of that, its content security policy forbids every connection (`connect-src 'none'`) and loading any outside scripts, images, fonts or stylesheets. Sites are blocked with `declarativeNetRequest`: the browser itself compares addresses with your list – the extension never sees individual requests.

## Permissions

| Permission | Why |
|---|---|
| `storage` | keep your settings locally |
| `declarativeNetRequest` | block sites without reading your traffic |
| `activeTab` | show the current tab's address in the popup – only after you click it, only for that tab |
| `alarms` | switch unlocks, schedule, focus and lock mode on time. No install warning, no data access |
| optional: access to **blocked** domains | only for the custom block page and only if you turn it on. Requested per domain and revoked automatically when the domain is removed or the feature is turned off |
| content script on `www.youtube.com` | hide and filter YouTube elements. Runs on no other site, has **no** storage access and only receives the YouTube settings, not your website list |

No permanent `host_permissions`, no `tabs`, no `history`, no `webRequest`, no `cookies`.

## Export and import

Exporting creates a JSON file locally that you save yourself. Importing reads the file you choose, sanitizes it and stores it. Nothing is uploaded.

## Firefox

The Firefox manifest declares `data_collection_permissions: none`, so Firefox shows during installation that no data is collected.
