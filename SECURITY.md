# Sicherheits- und Datenschutz-Audit – FocusGuard 1.0.0

Stand: 27.10.2026 · geprüft: der gesamte Quellcode (~1.400 Zeilen, keine Fremdbibliotheken)

## Ergebnis auf einen Blick

| Bereich | Ergebnis |
|---|---|
| Netzwerkzugriffe der Erweiterung | **0**, im echten Browser mitgeschnitten |
| Kritische Funde im statischen Scan | **0** |
| Unit- und Sicherheitstests | **13/13** bestanden |
| Browsertests (Chromium) | **45/45** bestanden, zweimal reproduziert |
| Fremde Abhängigkeiten im Paket | **keine** (kein Supply-Chain-Risiko) |
| Während des Audits gefundene Fehler | 1 funktionaler Fehler, 1 Härtungspunkt, beide behoben (siehe unten) |

## 1. Angriffsfläche und Rechte

**Rechte (minimal):** `storage`, `declarativeNetRequest`, `activeTab`. **Keine** `host_permissions`, kein `tabs`, `history`, `webRequest`, `cookies`, `scripting` oder `downloads`. Das Inhaltsskript läuft ausschließlich auf `https://www.youtube.com/*`, in der isolierten Welt (nicht `MAIN`) und nicht in iframes.

**Website-Sperre ohne Mitlesen:** `declarativeNetRequest` mit der Aktion `block`. Der Browser blockiert selbst, die Erweiterung sieht keine Anfragen. Für `block` sind keine Host-Rechte nötig.

**Keine Angriffsfläche von außen:** kein `externally_connectable`, kein `web_accessible_resources`, kein `onMessageExternal`. Webseiten können nicht mit der Erweiterung sprechen, das ist im Browser verifiziert.

**Content-Security-Policy der Erweiterungsseiten:**
```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'
```
Verboten sind damit: jede Netzwerkverbindung, fremde Skripte, Schriften, Bilder und Styles, `eval`, Inline-Skripte und Inline-Styles. Im Test hat die CSP sogar den `new Function`-Aufruf des Testskripts selbst blockiert, sie wirkt also tatsächlich.

## 2. Prüfmethoden

### 2.1 Statische Analyse (`tests/static-scan.js`)
Ein AST-basierter Scanner (TypeScript-Parser) durchsucht jede JS-, HTML- und CSS-Datei sowie das Manifest nach:
- Netzwerk-APIs: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `RTCPeerConnection`, `Worker`, dynamisches `import()`
- Codeausführung: `eval`, `Function`, String-Timer, `importScripts` mit variablen Pfaden
- HTML-Injektion: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `srcdoc`
- riskanten Erweiterungs-APIs und Navigationen mit variablem Ziel
- Inline-Skripten, Event-Handlern, externen Ressourcen in HTML und CSS (`@import`, `url()`)
- Manifest: unerwarteten Rechten, Host-Zugriff, CSP-Lücken, `externally_connectable`, Content-Script-Scope

**Ergebnis: 0 kritische Funde.** Die 7 Hinweise sind geprüft und unbedenklich: `importScripts('shared.js')` mit fester lokaler Datei, vier Navigationen zu festen relativen YouTube-Pfaden (Video-ID per `encodeURIComponent`), eine `blob:`-URL für den lokalen Export und `new URL('http://' + …)` als reines lokales Parsen für Umlaut-Domains (dabei wird nichts angefragt).

**Gegenprobe:** In einer Kopie wurden absichtlich Lücken eingebaut (`fetch` mit Cookie, `innerHTML`, `eval`, `new Function`, String-Timer, `document.write`, dynamisches Import, WebSocket, `sendBeacon`, Inline-Skript, Inline-Handler, externes Bild, CSS-`@import`, `<all_urls>`, `tabs`, `unsafe-eval`). Der Scanner hat **alle** gemeldet.

### 2.2 Unit- und Sicherheitstests (`tests/unit.test.js`)
- **Bösartige Eingaben:** HTML/JS in Domains und Kanalnamen, `javascript:`-URLs, kaputte Kodierungen, falsche Datentypen, `null` und Objekte. Alles wird verworfen oder als harmloser Text behandelt.
- **Prototype Pollution:** `__proto__`- und `constructor.prototype`-Nutzlasten im Import bleiben wirkungslos.
- **Größenbegrenzung:** Höchstens 2.000 Einträge pro Liste und 200 Zeichen pro Eintrag; Importdateien höchstens 512 KB.
- **ReDoS:** Alle regulären Ausdrücke wurden mit 200.000-Zeichen-Eingaben getestet, die jeweils über 250 ms Laufzeit als Fehler gelten würden.
- **Fuzzing (2.000 Läufe):** Die Bereinigung ist idempotent. Das verhindert Endlos-Schreibschleifen.
- **Sperrmodus (5.000 Zufallsläufe):** Das Ergebnis ist **nie** lockerer als der Stand bei Sperrbeginn und ein Fixpunkt.
- **Regression:** Simuliertes Chrome-Speicherverhalten (sortierte Schlüssel). Der Hintergrundabgleich endet nach höchstens 3 Schreibvorgängen.

### 2.3 Browsertest mit Netzwerk-Mitschnitt (`tests/e2e.test.js`)
Die Erweiterung läuft in echtem Chromium. **Jeder Hostname der Welt** wird auf lokale Server umgeleitet, die jede eingehende Anfrage protokollieren. Ein **Kontrolllauf ohne Erweiterung** misst vorher Chromiums eigenen Hintergrundverkehr. YouTube ist nachgebaut, inklusive präparierter XSS-Titel und -Kanalnamen.

Geprüft und bestanden:
- Die Website-Sperre greift für Domain und Subdomains. **Die gesperrte Domain hat den Server nie erreicht.**
- YouTube: Feed, Shorts, Empfehlungen, Kommentare und Endcards sind ausgeblendet, Autoplay ist aus, Shorts werden umgeleitet.
- Filter: Kanal, Stichwort und strikter Modus funktionieren in der Suche, auf Video- und auf Kanalseiten.
- Ein gesperrtes Video bleibt pausiert, auch wenn es per Skript neu gestartet wird.
- **XSS:** Präparierte Titel und Kanalnamen (`<img onerror=…>`) bleiben in YouTube und in der Einstellungsseite reiner Text.
- **Isolation:** Die Logik der Erweiterung ist für die Webseite unsichtbar, und die Webseite hat keinen Kanal zur Erweiterung.
- **Vier Manipulationsversuche während der Sperre** werden automatisch zurückgedreht: Speicher überschreiben, Speicher komplett löschen, Sperre verkürzen, bösartiger Import.
- **Netzwerk:** 0 Anfragen aus Erweiterungsseiten oder dem Service Worker. Kein Server erhielt je eine Anfrage mit Erweiterungs-Herkunft. Außer den vom Test aufgerufenen Seiten wurden nur Hosts kontaktiert, die Chromium **auch ohne die Erweiterung** kontaktiert (Zeitabgleich, Komponenten-Updates, Kontoprüfung).
- Keine JavaScript- und keine CSP-Fehler.

## 3. Während des Audits gefunden und behoben

1. **Endlos-Schreibschleife im Hintergrund (funktional, hoch):** Chrome gibt gespeicherte Objekte mit alphabetisch sortierten Schlüsseln zurück. Der Vergleich im Hintergrund war reihenfolgeabhängig, hielt unveränderte Daten deshalb für geändert und schrieb sie endlos neu (gemessen: 3.862 Schreibvorgänge in 200 ms). Dadurch wurde die Sperrregel nie gesetzt. **Fix:** reihenfolgeunabhängiger Vergleich. **Regressionstest:** Mit dem alten Code schlägt er fehl, mit dem neuen besteht er.
2. **Rechtschreibprüfung lädt Wörterbuch (Härtung, niedrig):** Beim Tippen in die Eingabefelder lud Chromiums Rechtschreibprüfung ein Wörterbuch von Google. Das ist Browserverhalten, nicht Code der Erweiterung, ließ sich aber vermeiden. **Fix:** `spellcheck="false"` an allen Eingabefeldern. Danach war der Aufruf im Mitschnitt verschwunden.
3. Ein Inline-Style in `options.html` hätte gegen die eigene CSP verstoßen und wurde in `ui.css` verschoben.

## 4. Restrisiken (ehrlich bewertet)

| Risiko | Einschätzung |
|---|---|
| **Selbst-Umgehung:** Erweiterung deaktivieren oder deinstallieren, anderen Browser nutzen, Inkognito ohne Freigabe | Prinzipbedingt bei jeder Erweiterung. Abhilfe: Inkognito freigeben, Router-Sperre beibehalten, optional eine Browser-Richtlinie, die jemand anderes setzt |
| **Erkennbarkeit:** YouTube könnte anhand der ausgeblendeten Elemente bemerken, dass ein Inhaltsfilter aktiv ist | Gilt für jede Erweiterung, die Seiten verändert (auch Unhook und uBlock). Dabei werden keine Daten übertragen |
| **Einstellungen unverschlüsselt im Profil** | Sie enthalten nur deine Sperrlisten. Wer Zugriff auf dein Browserprofil hat, hat ohnehin mehr |
| **YouTube ändert den Seitenaufbau** | Ausblenden kann dann teilweise wegfallen. Im strikten Modus wird im Zweifel gesperrt |
| **Keine automatischen Updates** (entpackt geladen) | Vorteil: Niemand kann unbemerkt Code nachschieben. Nachteil: Korrekturen musst du selbst einspielen |

## 5. Nicht durchgeführt
- **ESLint-Sicherheitsplugins und Mozillas `web-ext lint`:** In der Prüfumgebung war die npm-Registry gesperrt. Ersatz waren der eigene AST-Scanner (mit Gegenprobe) und manuelle Manifest-Prüfungen. Empfehlung: einmal lokal `npx web-ext lint` ausführen.
- **Firefox-Laufzeittest:** In der Prüfumgebung stand nur Chromium zur Verfügung. Die Logik ist identisch, das Manifest ist für Firefox vorbereitet.
- **Test gegen das echte YouTube:** Ohne Internetzugang wurde ein Nachbau verwendet. Die Selektoren entsprechen dem aktuellen YouTube-Aufbau, können sich aber ändern.

## Selbst nachprüfen
```bash
node --test tests/unit.test.js
node tests/static-scan.js
node tests/e2e.test.js
grep -rnE "fetch|XMLHttpRequest|WebSocket|sendBeacon|innerHTML|eval\(" --include=*.js . | grep -v tests/
```
Der letzte Befehl findet im Erweiterungscode nur zwei Kommentarzeilen, die genau das Fehlen dieser APIs dokumentieren.
