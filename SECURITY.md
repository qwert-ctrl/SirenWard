# Sicherheits-, Architektur- und Datenschutz-Audit – FocusGuard 1.2.0

Stand: 27.10.2026 · Umfang: gesamter Quellcode (keine Fremdbibliotheken zur Laufzeit) und das gebaute Paket

## Ergebnis auf einen Blick

| Prüfung | Ergebnis |
|---|---|
| Netzwerkanfragen der Erweiterung (echter Browser, Mitschnitt aller Hosts) | **0** |
| Statischer Sicherheits- und Architektur-Scan (Repo und Paket) | **0 kritisch** |
| Unit- und Hintergrundtests (inkl. Fuzzing, Zufallstests, Uhr-Angriffe, Nebenläufigkeit, Partner-Code) | **66/66** |
| Mutationstests (absichtlich eingebaute Fehler) | **57/57 erkannt** |
| Browserprüfungen in Chromium, gegen das **gebaute Paket** | **77/77** |
| Eigene Sperrseite (Weiterleitung, Freigabe, automatisches Neusperren) | **8/8** |
| `chrome://extensions`: Manifest-Fehler, Warnungen, Laufzeitfehler | **keine** |
| CSP-Probe mit echtem Erweiterungscode (eval, Function, innerHTML, fremde Skripte, fetch) | **alles blockiert** |
| Build | reproduzierbar (bitgleiche ZIPs für Chromium und Firefox), nur referenzierte Laufzeitdateien |

## 1. Angriffsfläche

**Rechte:** `storage`, `declarativeNetRequest`, `activeTab`, `alarms`. **Keine** dauerhaften `host_permissions`, kein `tabs`, `history`, `webRequest`, `cookies` oder `scripting`. Optional, nur für die eigene Sperrseite: Zugriff auf einzelne **gesperrte** Domains (`optional_host_permissions` als Obergrenze; wird pro Domain angefragt und automatisch wieder entzogen). Das Inhaltsskript läuft nur auf `https://www.youtube.com/*`, in der isolierten Welt und nicht in iframes.

**Von außen nicht erreichbar:** kein `externally_connectable`, keine `web_accessible_resources` (Webseiten können die Erweiterung nicht erkennen oder ansprechen) und kein `onMessageExternal`. Nachrichten von anderen Erweiterungen werden ignoriert.

**Vertrauensgrenzen:**

| Kontext | Darf |
|---|---|
| Popup, Einstellungen, Sperrseite (eigene Seiten) | Einstellungen lesen (ohne Partner-Hash); Änderungen nur als **Befehl** an den Hintergrund. Interne Befehle (z. B. `partnerStore`) sind nicht aufrufbar |
| YouTube-Skript (läuft im Prozess einer fremden Webseite) | nur eine **Leseansicht** (YouTube-Optionen, Filter, Limit). Kein Speicherzugriff (`setAccessLevel: TRUSTED_CONTEXTS`), keine Website-Liste, keine Befehle. Darf Wiedergabezeit melden – begrenzt auf die tatsächlich vergangene Zeit pro Tab |
| Hintergrund | einziger Schreiber; prüft Absender, Schema, Größe und Sperrmodus |

**Content-Security-Policy** der Erweiterungsseiten:
```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none';
object-src 'none'; form-action 'none'; base-uri 'none';
require-trusted-types-for 'script'; trusted-types 'none'
```
Keine Verbindungen, keine fremden Ressourcen, kein `eval`. **Neu in 1.1:** Trusted Types sperren zusätzlich alle HTML- und Skript-Injektionssenken (`innerHTML`, String-Timer, Skript-Elemente). Ein künftiger Programmierfehler kann damit keine XSS-Lücke öffnen.

## 1a. Neu in 1.2: Bedrohungsmodell der Zusatzfunktionen

| Angriff | Abwehr | Test |
|---|---|---|
| Wartezeit/Abtippen per DevTools umgehen | Wartezeit, Satz, Kontingent und Fokus prüft der **Hintergrund**; Anfrage und Bestätigung sind zwei Schritte | Unit + Browser („Hintergrund erzwingt die Wartezeit“) |
| Uhr zurückstellen, um eine Freigabe zu verlängern | Restzeit nie länger als die Freigabedauer; Rücksprünge werden erkannt | Unit (inkl. gelöschtem Uhrwert) + Mutation |
| Uhr umstellen, um neues Tageskontingent zu bekommen | Tag = spätester gesehener Tag | Unit + Mutation |
| Zähler/Freigaben/Fokus im Speicher zurücksetzen | Externe Änderungen am Zustand werden nur übernommen, soweit sie nicht lockern | Unit + Hintergrund + Mutation |
| Partner-Code erraten | PBKDF2-SHA-256 mit 600.000 Runden; Ratenbegrenzung ab dem 5. Fehlversuch (5 → 60 min); Vergleich in konstanter Zeit | Hintergrund + Mutation |
| Partner-Code auslesen | nur Hash im Speicher, nie in der Oberfläche, nie im Export | Hintergrund + Browser |
| Partner-Schutz per Speicher-Manipulation abschalten | Snapshot ist maßgeblich und wird repariert | Hintergrund + Browser |
| Gefälschte YouTube-Wiedergabezeit (kompromittierter Webseiten-Prozess) | nur vom YouTube-Skript, gedeckelt auf die vergangene Zeit pro Tab und 30 s pro Meldung; zu viel melden macht nur strenger | Hintergrund + Mutation |
| Webseite missbraucht die Sperrseite (Clickjacking, Erkennen der Erweiterung) | keine `web_accessible_resources`; Darstellung im Frame verweigert; nur Domains von der Sperrliste | Browser |
| Zu weite Host-Rechte | nur pro gesperrter Domain, automatisch entzogen; der Scanner verbietet andere optionale Rechte | Hintergrund + Mutation + Scanner |

**Ehrliche Grenze:** Zeitplan und Fokus richten sich nach der Systemuhr. Wer die Uhr dauerhaft vorstellt, beendet Fokus und Zeitfenster früher. Eine verstellte Uhr verlängert aber nie eine Freigabe, bringt kein neues Kontingent und hebt keinen Sperrmodus dauerhaft auf.

## 2. Prüfmethoden

### 2.1 Statischer Scan (`tests/static-scan.js`)
Der AST-basierte Scanner ermittelt die Laufzeitdateien aus dem Manifest (dieselbe Quelle wie der Build) und prüft:
- **Sicherheit:** Netzwerk-APIs, Codeausführung, HTML-Senken, riskante APIs, externe Ressourcen, Inline-Code, Rechte, CSP inkl. Trusted Types
- **Architektur:**
  - Nur `background.js` schreibt in den Speicher.
  - `content.js` nutzt keinen Speicher.
  - Kein `importScripts`.
  - Kein `storage.sync`.
  - Eingabefelder ohne Rechtschreibprüfung.
  - Das Paket enthält nur referenzierte Dateien.

Ergebnis: 0 kritische Funde. Die 7 Hinweise sind geprüft und unbedenklich:
- ein statischer Import von `./core.js`
- vier Navigationen zu festen relativen YouTube-Pfaden
- eine `blob:`-URL für den lokalen Export
- `new URL('http://' + …)` als reines lokales Parsen für Umlaut-Domains

### 2.2 Unit- und Hintergrundtests
Die Logik in `core.js` ist rein funktional und wird direkt getestet. `background.js` läuft gegen einen verhaltenstreuen Browser-Ersatz (`tests/lib/fake-chrome.js`), der z. B. Chromes sortierte Speicherschlüssel und asynchrones `onChanged` nachbildet. Geprüft wird unter anderem:
- **Absender:**
  - YouTube-Skript, fremde Erweiterung und gefälschte URL werden abgelehnt.
  - Das YouTube-Skript erhält keine Website-Liste.
- **Nebenläufigkeit:** 50 gleichzeitige Befehle, keine verlorene Änderung.
- **Sperrmodus:** Befehle zum Lockern werden abgelehnt.
  - Überschreiben, Löschen des Speichers und Löschen des Snapshots werden repariert.
- **Uhr-Angriff:** Uhr vordrehen → Regeln löschen → Uhr zurück → die Regeln sind wieder da.
  - Auch dann, wenn zusätzlich der Snapshot gelöscht wurde.
  - Ein kleiner NTP-Abgleich nach regulärem Ablauf schaltet die Sperre **nicht** wieder scharf.
- **Robustheit:**
  - 3.000 Zufallsläufe zeigen, dass die Sperr-Richtlinie ein Fixpunkt und nie lockerer als eine aktive Sperre ist.
  - Prototype Pollution bleibt wirkungslos.
  - Kein ReDoS bei Eingaben mit 200.000 Zeichen.
  - Ungültige Befehle werden abgelehnt.
- **Effizienz:** Keine Schreibschleifen, keine unnötigen Neuschreibungen der Sperrregel, keine doppelten Benachrichtigungen.

### 2.3 Mutationstests (`tests/mutation.sh`)
Damit grüne Tests etwas bedeuten, werden 32 Fehler gezielt eingebaut. Jeder muss einen Test rot machen.
- **Logik (21):** ausgehebelte Absenderprüfung, entfernter Uhr-Schutz, Lockern während der Sperre auf jedem Weg, entfernte Warteschlange, Datenleck an YouTube, Größengrenzen, verschluckte Benachrichtigung …
- **Scanner (11):** direkter Speicherzugriff, `importScripts`, Trusted Types entfernt, `connect-src` geöffnet, `innerHTML`, `fetch`, `storage.sync`, `<all_urls>`, Inline-Skript, Rechtschreibprüfung.

**Ergebnis: 57/57 erkannt** (1.2: +25 Mutationen für Zeitfreigabe, Partner-Code, Zustand, Zeitplan, YouTube-Limit, Host-Rechte und das Manifest).

### 2.4 Browsertest mit Netzwerk-Mitschnitt (`tests/e2e.test.js`)
**Aufbau:**
- Die Erweiterung läuft in echtem Chromium, geprüft wird **das gebaute Paket**.
- Jeder Hostname wird auf protokollierende lokale Server umgeleitet.
- Ein Kontrolllauf ohne Erweiterung misst Chromiums eigenen Verkehr.
- YouTube ist nachgebaut, inklusive präparierter XSS-Titel.

**77 Prüfungen, alle bestanden** (1.2 neu: Zeitfreigabe Ende-zu-Ende, Zeitplan, Partner-Code-Dialog, Fokus, Tageslimit, YouTube-Optionen, Statistik, `chrome://extensions` fehlerfrei), **darunter:**
- Website-Sperre (die gesperrte Domain erreicht nie einen Server)
- 20 gleichzeitige Änderungen aus zwei Seiten, alle gespeichert
- Fokus bleibt nach Änderungen erhalten
- 0 von 202 gesperrten Videos im ersten Bild sichtbar
- Sperrseite: Video bleibt angehalten, Seite dahinter `inert`, Fokus im Dialog
- Strikter Modus: Ein erlaubtes Video läuft nach der Prüfung weiter, ein fremdes bleibt gestoppt
- Vier Manipulationsversuche während der Sperre werden repariert
- Kein XSS, keine Prototype Pollution, Isolation von der Webseite
- **0 Anfragen der Erweiterung nach außen**, keine JS- oder CSP-Fehler

### 2.5 CSP-Probe (`tests/csp-probe.test.js`)
**Warum ein eigener Test:** DevTools-Ausführung umgeht Teile der CSP, deshalb läuft die Probe als eigene Seite mit echtem Erweiterungscode.

**Ergebnis in 1.1:**
- Blockiert: `eval`, indirektes `eval`, `new Function`, `setTimeout(String)`, `innerHTML`, fremdes Skript, `fetch`.
- 0 Anfragen erreichen einen Server.

**Vergleich mit 1.0:** Dort waren `innerHTML`, String-Timer und das Einfügen von Skript-Elementen noch möglich. Geladen bzw. ausgeführt wurde dabei aber nichts.

## 3. Gefundene und behobene Probleme (1.0 → 1.1)

| # | Problem | Schwere | Nachweis | Status |
|---|---|---|---|---|
| 1 | Verlorene Änderungen bei schnellen Aktionen | hoch | Test: 20 gleichzeitige Änderungen → **1** gespeichert | behoben: Single Writer + Warteschlange |
| 2 | Sperrmodus durch Vorstellen der Systemuhr umgehbar | hoch | Logik | behoben: Rücksprung-Erkennung, Snapshot bleibt erhalten |
| 3 | Gesperrte Videos blitzen auf | mittel | Benchmark: **560/1.602** sichtbar | behoben: 0 |
| 4 | Strikter Modus: fremdes Video läuft bis zu 4 s | mittel | Code | behoben: Video-Tor (fail-closed) |
| 5 | YouTube-Skript hatte Schreibzugriff auf alle Einstellungen | mittel (Härtung) | Code | behoben: kein Speicherzugriff, nur Leseansicht |
| 6 | Keine Absenderprüfung, keine Schema-Validierung für Änderungen | mittel | Code | behoben |
| 7 | Einstellungen bauen sich bei jeder Änderung neu auf → Fokusverlust; nach Sperr-Ende alle 15 s | niedrig (Barrierefreiheit) | Code | behoben |
| 8 | Ungebremste Neuberechnung bei Player-Ticks und beim Scrollen | Leistung | Benchmark | behoben: −85 % / −70 % |
| 9 | Sperrregel bei jeder Änderung neu geschrieben | Leistung | Code | behoben |

**In 1.2 gefunden und behoben:**
- **Manifest (Fehlermeldung in Brave):** `background.scripts` neben `service_worker` erzeugt in Chromium-Browsern einen Manifest-Fehler. Jetzt gibt es getrennte Pakete; der Browsertest liest `chrome://extensions` aus und der Scanner verbietet die Kombination.
- **Echo-Fehler:** Eine mit Partner-Code autorisierte Lockerung wurde durch das eigene Speicher-Echo zurückgedreht. Jetzt gibt es Echo-Erkennung, und maßgeblich ist allein der Snapshot. Ein Regressionstest ist ergänzt.
- **Zwei Testlücken**, aufgedeckt durch Mutationstests, sind geschlossen.

**Während des Umbaus auf 1.1 durch die Tests gefunden** (nie ausgeliefert):
- Trusted Types sperren auch `importScripts` im Service Worker. Gelöst durch die Umstellung auf ein ES-Modul.
- Eine Änderung, die den schlafenden Service Worker weckt, wäre nicht bei offenen YouTube-Tabs angekommen. Gefunden durch einen Mutationstest.

## 4. Leistung (Chromium, Median aus 5 Läufen, zusätzliche Skriptzeit)

| Szenario | 1.0 | 1.1 |
|---|---|---|
| Nachladen beim Scrollen (30 × 40 Videos, wie YouTube) | 308 ms | **92 ms** |
| 8 s Videowiedergabe | 77 ms | **12 ms** |
| Aufblitzen gesperrter Videos | 560 / 1.602 | **0 / 1.602** |
| Extremfall: 1.500 Kacheln auf einmal vom Parser | 37 ms | 49 ms |

Den Extremfall erkauft sich 1.1 bewusst mit etwas mehr CPU: Es filtert vor dem ersten Bild statt einmal nach 200 ms. Echtes YouTube rendert per JavaScript nach, und dort (Zeile 1) ist 1.1 rund dreimal schneller.

## 5. Restrisiken

| Risiko | Einschätzung |
|---|---|
| **Selbst-Umgehung:** Erweiterung deaktivieren oder deinstallieren, anderen Browser nutzen | prinzipbedingt; Abhilfe: Router-Sperre, Inkognito freigeben, Browser-Richtlinie durch eine andere Person |
| Systemuhr dauerhaft falsch lassen | Solange die Uhr falsch bleibt, wirkt die Sperre abgelaufen. Nach dem Zurückstellen greift sie wieder. Eine dauerhaft falsche Uhr stört allerdings viele Websites |
| Erkennbarkeit durch YouTube (ausgeblendete Elemente) | gilt für jede seitenverändernde Erweiterung; es werden keine Daten übertragen |
| YouTube ändert den Seitenaufbau | Ausblenden kann teilweise wegfallen; im strikten Modus wird im Zweifel gesperrt |
| Firefox kennt `setAccessLevel` nicht | Das YouTube-Skript nutzt den Speicher trotzdem nie (vom Scanner erzwungen) |

## 6. Nicht durchgeführt
- **ESLint-Plugins und `web-ext lint`:** Die npm-Registry war in der Prüfumgebung gesperrt. Ersatz waren der eigene AST-Scanner mit Mutations-Gegenprobe und die Manifestprüfung. Empfehlung: lokal `npx web-ext lint -s dist/focusguard` ausführen.
- **Firefox-Laufzeittest:** Es war nur Chromium verfügbar.
- **Test gegen echtes YouTube:** Ohne Internetzugang wurde ein Nachbau verwendet.

## Selbst nachprüfen
```bash
npm run verify     # Unit-Tests, Scan, Mutationen, Build, Browsertest + CSP-Probe gegen das Paket
```
