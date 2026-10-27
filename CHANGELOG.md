# Changelog

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
