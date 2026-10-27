# Datenschutzerklärung – FocusGuard

**Kurz: FocusGuard erhebt, überträgt und verkauft keine Daten. Punkt.**

## Was gespeichert wird
Gespeichert werden nur die Einstellungen, die du selbst eingibst: gesperrte Websites, YouTube-Optionen, gesperrte oder erlaubte Kanäle, Stichwörter und das Ende einer aktiven Sperre. Für den Sperrmodus kommen eine Kopie der Regeln bei Sperrbeginn und der späteste bisher gesehene Zeitpunkt hinzu; daran erkennt FocusGuard, ob jemand die Uhr verstellt hat. Alles liegt in `chrome.storage.local`, also ausschließlich in deinem Browserprofil auf diesem Gerät. Bewusst **nicht** `storage.sync`, damit nichts über das Google- oder Mozilla-Konto synchronisiert wird.

## Was nicht gespeichert wird
- kein Browserverlauf, keine besuchten Seiten, keine angesehenen Videos
- keine Statistiken, Zähler oder Nutzungsdaten
- keine Kennungen, keine Cookies, kein Fingerprinting

## Netzwerk
FocusGuard enthält keinen Code, der Netzwerkanfragen stellt. Zusätzlich verbietet die Content-Security-Policy der Erweiterung jede Verbindung (`connect-src 'none'`) sowie das Nachladen fremder Skripte, Bilder, Schriften und Stylesheets. Die Website-Sperre läuft über `declarativeNetRequest`: Der Browser vergleicht Adressen selbst mit deiner Liste, die Erweiterung bekommt die einzelnen Aufrufe gar nicht zu sehen.

## Berechtigungen
| Berechtigung | Wofür |
|---|---|
| `storage` | deine Einstellungen lokal speichern |
| `declarativeNetRequest` | gesperrte Websites blockieren, ohne den Datenverkehr mitzulesen |
| `activeTab` | im Popup die Adresse des aktuellen Tabs anzeigen. Nur nach deinem Klick und nur für diesen Tab |
| `alarms` | den Sperrmodus regelmäßig überprüfen (z. B. nach einer Uhr-Manipulation). Keine Installationswarnung, kein Datenzugriff |
| Inhaltsskript auf `www.youtube.com` | YouTube-Elemente ausblenden und filtern. Läuft auf keiner anderen Website, hat **keinen** Zugriff auf den Speicher und bekommt nur die YouTube-Einstellungen, nicht deine Website-Liste |

Keine `host_permissions`, kein `tabs`, kein `history`, kein `webRequest`, kein `cookies`.

## Export und Import
Beim Export erstellt dein Browser lokal eine JSON-Datei, die du selbst speicherst. Beim Import liest die Erweiterung die von dir gewählte Datei, bereinigt den Inhalt und speichert ihn. Dabei wird nichts hochgeladen.

## Firefox
Im Manifest ist `data_collection_permissions: none` gesetzt. Firefox zeigt dir damit bei der Installation an, dass keine Daten erhoben werden.
