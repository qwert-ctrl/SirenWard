# FocusGuard

Open-Source-Browsererweiterung gegen digitale Ablenkung. Sie kombiniert **Website-Sperre**, die Ansichtsfunktionen von **Unhook** und die Filter von **BlockTube** und hat einen **Sperrmodus**, den du dir selbst nicht einfach wieder abschalten kannst.

**Datenschutz zuerst:** keine Server, keine Konten, kein Tracking, keine Statistiken, kein Verlauf. Die Erweiterung hat technisch keine Möglichkeit, Daten zu versenden (siehe [SECURITY.md](SECURITY.md)).

Läuft in Chrome, Edge, Brave, Vivaldi, Opera (Manifest V3) und Firefox ab Version 128.

## Funktionen

**Websites sperren**
- Domains inklusive aller Subdomains sperren (`instagram.com` sperrt auch `www.` und `m.`)
- Die Sperre sitzt im Browser selbst. Deshalb greift sie **auch mit VPN, anderem DNS oder DNS-over-HTTPS**, anders als eine Router-Sperre.
- Über das Popup sperrst du die aktuelle Seite mit einem Klick.

**YouTube-Ansicht (wie Unhook)**
- Startseiten-Feed ausblenden oder direkt zu den Abos weiterleiten
- Empfehlungen neben und unter Videos ausblenden
- Shorts überall ausblenden; Shorts-Links öffnen als normales Video
- Kommentare, Endcards und Vorschläge im Player ausblenden
- Autoplay abschalten

**YouTube-Filter (wie BlockTube)**
- Kanäle sperren (per @Handle, Name oder Link)
- Stichwörter im Titel sperren
- **Strikter Modus:** Nur Kanäle, die du erlaubst, sind sichtbar und abspielbar.
- Gesperrte Videos verschwinden aus Feeds und Suche. Wer sie direkt aufruft, sieht eine Sperrseite und das Video bleibt pausiert.

**Sperrmodus**
- Gilt für 1 Stunde bis 30 Tage. In dieser Zeit lassen sich Regeln nur **verschärfen**, nicht lockern.
- Versuche, die Einstellungen am Speicher vorbei zu ändern (DevTools, Import, Speicher löschen), werden automatisch zurückgedreht.

## Installation

### Chrome, Edge, Brave
1. Ordner entpacken.
2. `chrome://extensions` öffnen (Edge: `edge://extensions`).
3. **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** wählen und den Ordner `focusguard` auswählen.
5. Optional, aber empfohlen: In den Details der Erweiterung **„Im Inkognito-Modus zulassen“** einschalten, sonst greift die Sperre dort nicht.

### Firefox
- Zum Testen: `about:debugging#/runtime/this-firefox` → **Temporäres Add-on laden** → `manifest.json` auswählen. Das bleibt nur bis zum Neustart aktiv.
- Dauerhaft: Das Add-on kostenlos und privat („unlisted“) über [addons.mozilla.org](https://addons.mozilla.org/developers/) signieren lassen und die signierte `.xpi` installieren.
- Prüfe danach unter *Add-ons → FocusGuard → Berechtigungen*, ob der Zugriff auf `www.youtube.com` erlaubt ist.
- Für die privaten Fenster *„In privaten Fenstern ausführen“* aktivieren.

## Bedienung
- **Popup** (Klick auf das Symbol): aktuelle Seite sperren, YouTube-Kanal sperren oder erlauben
- **Einstellungen** (Rechtsklick auf das Symbol → *Optionen*): alle Listen, YouTube-Optionen, Sperrmodus, Export und Import

## Ehrliche Grenzen
Eine Browsererweiterung kann man immer deaktivieren oder deinstallieren, und ein anderer Browser ist nicht geschützt. Der Sperrmodus macht spontanes Abschalten deutlich unbequemer, ist aber kein Schutz gegen jemanden, der es wirklich will. Für mehr Härte kombinierst du FocusGuard mit der Router-Sperre, die du schon hast. Gegen das Deinstallieren hilft eine Browser-Richtlinie (`ExtensionInstallForcelist` oder `ExtensionSettings`), die jemand anderes für dich einrichtet.

YouTube ändert gelegentlich seinen Seitenaufbau. Fällt dann ein Ausblenden weg, liegt das an den Selektoren in `content.css` und `content.js`. Im strikten Modus sperrt FocusGuard im Zweifel: Ein Video, dessen Kanal nicht erkannt wird, wird nach 4 Sekunden gesperrt.

## Aufbau

| Datei | Aufgabe |
|---|---|
| `manifest.json` | Rechte, strenge CSP, Einstiegspunkte |
| `shared.js` | Normalisierung, Bereinigung, Filterlogik, Sperrmodus-Regeln |
| `background.js` | setzt die Website-Sperre (declarativeNetRequest), erzwingt den Sperrmodus |
| `content.js` / `content.css` | YouTube: ausblenden, filtern, Sperrseite |
| `popup.*`, `options.*`, `ui.css` | Oberfläche |
| `tests/` | Unit-, Sicherheits- und Browsertests |

## Tests
```bash
node --test tests/unit.test.js     # Logik, Fuzzing, Sperrmodus, ReDoS, Prototype Pollution
node tests/static-scan.js          # statischer Sicherheits-Scan (braucht: typescript)
node tests/e2e.test.js             # echter Chromium-Test mit Netzwerk-Mitschnitt (braucht: playwright, openssl, Ports 80/443)
```

## Lizenz
MIT, siehe [LICENSE](LICENSE). Du darfst den Code frei nutzen, ändern und weitergeben.
