# FocusGuard

Open-Source-Browsererweiterung gegen digitale Ablenkung. Sie kombiniert **Website-Sperre**, die Ansichtsfunktionen von **Unhook** und die Filter von **BlockTube** und hat einen **Sperrmodus**, den du dir selbst nicht einfach wieder abschalten kannst.

**Datenschutz zuerst:** keine Server, keine Konten, kein Tracking, keine Statistiken, kein Verlauf. Die Erweiterung kann technisch keine Daten versenden (siehe [SECURITY.md](SECURITY.md)).

Läuft in Chrome, Edge, Brave, Vivaldi, Opera (ab Version 120) und Firefox (ab 128).

## Funktionen

**Websites sperren**
- Domains inklusive aller Subdomains sperren
- Die Sperre sitzt im Browser selbst. Deshalb greift sie **auch mit VPN, anderem DNS oder DNS-over-HTTPS**, anders als eine Router-Sperre.
- Über das Popup sperrst du die aktuelle Seite mit einem Klick.

**YouTube-Ansicht (wie Unhook)**
- Startseiten-Feed ausblenden oder direkt zu den Abos weiterleiten
- Empfehlungen, Shorts, Kommentare, Endcards und Autoplay abschalten
- Shorts-Links öffnen als normales Video

**YouTube-Filter (wie BlockTube)**
- Kanäle (per @Handle, Name oder Link) und Stichwörter im Titel sperren
- **Strikter Modus:** Nur Kanäle, die du erlaubst, sind sichtbar und abspielbar.
- Gesperrte Videos sind schon im ersten Bild unsichtbar. Wer sie direkt aufruft, sieht eine Sperrseite, und das Video bleibt angehalten.

**Sperrmodus**
- Gilt für 1 Stunde bis 30 Tage. In dieser Zeit lassen sich Regeln nur **verschärfen**, nicht lockern.
- Versuche, die Sperre zu umgehen, werden automatisch zurückgedreht: Speicher bearbeiten oder löschen, Import, Systemuhr vordrehen.

## Installation

Nimm `focusguard-1.1.0-extension.zip` und entpacke es. Der Ordner `focusguard` enthält nur die Dateien, die der Browser braucht.

### Chrome, Edge, Brave
1. `chrome://extensions` öffnen (Edge: `edge://extensions`).
2. **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** wählen und den entpackten Ordner `focusguard` auswählen.
4. Empfohlen: In den Details der Erweiterung **„Im Inkognito-Modus zulassen“** einschalten.

### Firefox
- Zum Testen: `about:debugging#/runtime/this-firefox` → **Temporäres Add-on laden** → `manifest.json` auswählen. Das bleibt bis zum Neustart aktiv.
- Dauerhaft: Das ZIP kostenlos und privat („unlisted“) über [addons.mozilla.org](https://addons.mozilla.org/developers/) signieren lassen und die `.xpi` installieren.
- Danach unter *Add-ons → FocusGuard → Berechtigungen* den Zugriff auf `www.youtube.com` erlauben und *„In privaten Fenstern ausführen“* aktivieren.

### Echtheit prüfen
```bash
sha256sum focusguard-1.1.0-extension.zip   # muss mit SHA256SUMS übereinstimmen
node tools/build.js                        # aus dem Quellcode neu bauen → bitgleiches ZIP
```

## Ehrliche Grenzen
Eine Browsererweiterung lässt sich immer deaktivieren oder deinstallieren, und andere Browser sind nicht geschützt. Der Sperrmodus macht spontanes Abschalten deutlich unbequemer, verhindert es aber nicht vollständig. Für mehr Härte kombinierst du FocusGuard mit der Router-Sperre. Gegen das Deinstallieren hilft eine Browser-Richtlinie, die jemand anderes für dich einrichtet. YouTube ändert gelegentlich seinen Seitenaufbau; die Selektoren stehen gesammelt in `content.js` und `content.css`.

## Architektur

```
 Popup / Einstellungen ──Befehl──▶ background.js ──schreibt──▶ storage.local
   (client.js)          ◀─Antwort─  (einziger Schreiber,        │
                                     serielle Warteschlange)    ├─▶ declarativeNetRequest (Website-Sperre)
                                          │                    └─▶ Sperr-Snapshot + Uhr-Überwachung
                                          │ Leseansicht (nur yt + filter)
                                          ▼
                                     content.js  (YouTube, isolierte Welt, KEIN Speicherzugriff)
                     alle Entscheidungen: core.js (reine Funktionen, ohne Ein-/Ausgabe)
```

| Datei | Aufgabe |
|---|---|
| `core.js` | **Functional Core:** Normalisierung, Bereinigung, Filter, Befehle (`applyOp`), Sperr-Richtlinie (`resolveState`). Ohne Browser-APIs, komplett in Node testbar |
| `background.js` | **Imperative Shell** (ES-Modul): einziger Schreiber, Absenderprüfung, Website-Sperre, Manipulationsschutz |
| `client.js` | schmale Befehls-API für Popup und Einstellungen |
| `content.js` / `.css` | YouTube: inkrementelles Filtern vor dem ersten Bild, Video-Tor, Sperrseite |
| `popup.*`, `options.*`, `ui.css` | Oberfläche (einmal aufgebaut, danach gezielt aktualisiert) |
| `tools/` | reproduzierbarer Build; `files.js` legt die Laufzeitdateien fest (einzige Quelle) |
| `tests/` | alle Tests, Benchmark, Test-Infrastruktur |

## Tests
```bash
npm test                 # 34 Unit-/Hintergrundtests + statischer Sicherheits- & Architektur-Scan
npm run test:mutation    # 32 absichtlich eingebaute Fehler – alle müssen erkannt werden
npm run test:e2e         # 52 Prüfungen in echtem Chromium mit Netzwerk-Mitschnitt + CSP-Probe
npm run bench            # Leistungsmessung
npm run verify           # alles, inkl. Build und Test des gebauten Pakets
```
Benötigt werden Node ≥ 20, die Pakete `typescript` und `playwright` (mit Chromium), `openssl`, `zip` sowie für den Browsertest die Ports 80 und 443.

## Lizenz
MIT, siehe [LICENSE](LICENSE).
