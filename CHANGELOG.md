# Changelog

## 1.2.1 – 29.10.2026
- **Neuer Name: Sirenward** (vormals FocusGuard – der Name war auf addons.mozilla.org bereits vergeben). Wie Odysseus an den Mast: Du legst dich im Voraus fest und widerstehst den Lockrufen.
- Eindeutige Firefox-ID (UUID) für die Veröffentlichung auf addons.mozilla.org.
- Funktion, Einstellungen und Speicherformat unverändert; Exporte aus FocusGuard lassen sich weiter importieren.

## 1.2.0 – 27.10.2026

### Neu
- **Zeitfreigabe:** Gesperrte Seiten lassen sich für z. B. 15 min freigeben, danach sperren sie sich von selbst wieder.
  - Tageslimit pro Seite.
  - Hürde: erst eine Wartezeit, dann einen Satz abtippen. Es zählen nur die Buchstaben, Groß-/Kleinschreibung ist egal, Einfügen ist gesperrt.
  - Freigeben geht im Popup und auf der Sperrseite. Vorzeitig wieder sperren ist jederzeit möglich.
  - Nach Ablauf laden offene Tabs nichts mehr nach.
- **Optionale Zusatzfunktionen** (standardmäßig aus):
  - Zeitplan, Fokus-Sitzung, eigene Sperrseite, Partner-Code
  - YouTube-Tageslimit, lokale Statistik
  - YouTube: Suchvorschläge und „Erkunden“/Trends ausblenden, Vorschaubilder in Graustufen
- **Popup:** Status auf einen Blick (Sperre, Fokus, Partner-Code, Zeitplan) und für die aktuelle Seite genau die passende Aktion.

### Behoben
- **Chrome/Brave:** Die Meldung `'background.scripts' requires manifest version of 2 or lower` ist weg. Es gibt jetzt getrennte Pakete für Chromium und Firefox. Ein Browsertest liest die Fehlerliste von `chrome://extensions` aus und erwartet sie leer.

### Sicherheit
- Wartezeit, Satz, Kontingent und Fokus prüft der Hintergrund. Ein Umgehen der Oberfläche, z. B. per DevTools, bringt nichts.
- **Uhr-Manipulation bei Freigaben:**
  - Uhr zurückstellen verlängert keine Freigabe; die Restzeit ist auf die Freigabedauer gedeckelt.
  - Das Kontingent folgt dem spätesten gesehenen Tag, nicht der verstellten Uhr.
- **Partner-Code:**
  - Gespeichert nur als PBKDF2-SHA-256-Hash mit 600.000 Runden und zufälligem Salz; verglichen in konstanter Zeit.
  - Ab dem 5. Fehlversuch steigende Wartezeit.
  - Der Hash erreicht die Oberfläche nie und wird nie exportiert.
- **Laufzeitzustand** (Zähler, Freigaben, Fokus): Manipulationen werden nur übernommen, soweit sie nicht lockern.
- **Host-Rechte für die eigene Sperrseite:**
  - Nur optional und nur pro gesperrter Domain.
  - Werden automatisch entzogen, sobald die Domain entfernt oder die Funktion abgeschaltet wird.
  - Die Sperrseite ist nicht für Webseiten zugänglich (keine `web_accessible_resources`) und verweigert die Darstellung in Frames.
- **YouTube-Wiedergabezeit:** Meldungen des YouTube-Skripts gelten als nicht vertrauenswürdig und werden pro Tab auf die tatsächlich vergangene Zeit begrenzt.

### Während der Entwicklung durch Tests gefunden
- Eine autorisierte Lockerung (Partner-Code) wurde Millisekunden später durch das eigene Speicher-Echo wieder zurückgedreht. Behoben durch Echo-Erkennung; maßgeblich für den Partner-Schutz ist jetzt allein der Snapshot. Ein Regressionstest ist ergänzt.
- CSS: Das `hidden`-Attribut wurde durch `display`-Regeln überschrieben. Jetzt hat `hidden` immer Vorrang.
- Zwei Testlücken, die der Mutationstest aufgedeckt hat: Kontingent bei der Bestätigung und Deckel für die Restzeit einer Freigabe.

### Tests
- 66 Unit- und Hintergrundtests
- 57 Mutationen, alle erkannt
- 77 Browserprüfungen in Chromium
- 8 Prüfungen der Sperrseite
- 8 Prüfungen der CSP-Probe
- Leistung: keine messbare Verschlechterung gegenüber 1.1

## 1.1.0 – 27.10.2026

### Behobene Fehler
- **Verlorene Änderungen:** Schnelle oder gleichzeitige Aktionen in Popup und Einstellungen haben sich gegenseitig überschrieben. Im Test wurde von 20 gleichzeitigen Änderungen nur eine gespeichert. Jetzt bleiben alle erhalten.
- **Aufblitzen gesperrter Videos:** Gesperrte Videos waren bis zu 200 ms sichtbar, im Test 560 von 1.602. Jetzt ist es keines mehr.
- **Strikter Modus:** Ein Video eines nicht erlaubten Kanals konnte bis zu 4 s laufen, bevor der Kanal erkannt war. Jetzt bleibt es angehalten, bis die Prüfung abgeschlossen ist.
- **Einstellungen:** Die Seite baute sich bei jeder Änderung komplett neu auf, wodurch der Tastaturfokus verloren ging. Nach Ablauf einer Sperre geschah das zusätzlich alle 15 s.
- **Randfall:** Weckte eine Speicheränderung den schlafenden Service Worker, kam sie nicht bei offenen YouTube-Tabs an.
- Die Sperrregel wurde bei jeder Änderung neu geschrieben, auch wenn sich die Websites nicht geändert hatten.

### Sicherheit
- **Trusted Types:** `innerHTML`, `eval`, `new Function`, String-Timer und Skript-Einfügungen sind in allen Erweiterungsseiten technisch gesperrt.
- **Schutz gegen Uhr-Manipulation:** Das Muster „Uhr vordrehen → Regeln löschen → Uhr zurück“ schaltet die Sperre automatisch wieder scharf. Kleine NTP-Korrekturen lösen das nicht aus.
- **Minimale Rechte für das YouTube-Skript:** Es hat keinen Speicherzugriff mehr und bekommt nur eine Leseansicht ohne Website-Liste.
- **Einziger Schreiber:** Nur der Hintergrund ändert Einstellungen. Befehle werden auf Absender (nur eigene Seiten), Schema und Größe geprüft.
- Ein gelöschter Sperr-Snapshot wird wiederhergestellt.
- **Reproduzierbarer Build:** Das Paket enthält nur Laufzeitdateien und SHA-256-Prüfsummen.

### Architektur und Leistung
- **Functional Core / Imperative Shell:** Die gesamte Logik steckt in reinen Funktionen (`core.js`) und ist vollständig in Node testbar.
- Der Service Worker ist ein ES-Modul.
- **Inkrementelles YouTube-Skript:** Es prüft nur geänderte Kacheln und ignoriert Änderungen innerhalb des Players.
  - Nachladen beim Scrollen: −70 % Skriptzeit
  - Videowiedergabe: −85 % Skriptzeit
- **Barrierefreiheit:** Die Sperrseite ist ein modaler Dialog mit Fokus, die Seite dahinter wird `inert`. Fehler erscheinen verständlich in der Oberfläche.
- Neue Berechtigung `alarms`. Sie erzeugt keine Warnung bei der Installation und wird für die Sperrüberwachung gebraucht.

### Tests
- 34 Unit- und Hintergrundtests, darunter Fuzzing, Zufallstests, Uhr-Angriffe und Nebenläufigkeit
- 32 Mutationstests: Absichtlich eingebaute Fehler müssen erkannt werden
- 52 Browserprüfungen in echtem Chromium mit Netzwerk-Mitschnitt
- CSP-Probe mit echtem Erweiterungscode
- Leistungs-Benchmark

## 1.0.0 – 27.10.2026
Erste Version.
