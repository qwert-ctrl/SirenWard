# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately instead:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (direct link: https://github.com/qwert-ctrl/SirenWard/security/advisories/new).
2. Describe what you found, how to reproduce it and which version and browser you used.

You'll get a reply within 7 days. Once a fix is released, the advisory is published and – if you like – credits you.

## In scope

- Anything that lets a web page, another extension or a compromised YouTube tab read, change or bypass SirenWard's settings
- Data leaving the device in any form
- Ways around lock mode, the partner code or timed unlocks that don't require disabling the extension itself
- Injection (XSS) in the extension's own pages

## Out of scope

- Disabling, removing or not installing the extension, or using another browser – that's inherent to every extension (see "Honest limits" in the README)
- Changes YouTube makes to its own page that stop elements from being hidden

## Supported versions

Only the latest release receives fixes.

The full security and privacy review of the current version is in [AUDIT.md](AUDIT.md).
