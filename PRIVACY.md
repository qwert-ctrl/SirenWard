# Datenschutzerklärung – Sirenward

**Kurz: Sirenward erhebt, überträgt und verkauft keine Daten. Punkt.**

## Was gespeichert wird
Gespeichert werden nur die Einstellungen, die du selbst eingibst: gesperrte Websites, YouTube-Optionen, gesperrte oder erlaubte Kanäle, Stichwörter und das Ende einer aktiven Sperre. Für den Sperrmodus kommen eine Kopie der Regeln bei Sperrbeginn und der späteste bisher gesehene Zeitpunkt hinzu; daran erkennt Sirenward, ob jemand die Uhr verstellt hat. Für Zeitfreigaben kommen die **heutigen** Zähler pro gesperrter Domain dazu, außerdem laufende Freigaben und Fokus-Sitzungen. Die Zähler werden am nächsten Tag automatisch zurückgesetzt. Ist das YouTube-Tageslimit an, wird die heutige Wiedergabezeit als **eine Zahl** gespeichert, ohne Videos und ohne Kanäle. Die **Statistik** zählt nur, wenn du sie einschaltest. Sie enthält dann Zähler pro Tag, keine Adressen, und wird nach 30 Tagen gelöscht. Ein **Partner-Code** wird nie im Klartext gespeichert, sondern nur als PBKDF2-Hash (600.000 Runden, zufälliges Salz), und verlässt beim Export nie das Gerät. Alles liegt in `chrome.storage.local`, also ausschließlich in deinem Browserprofil auf diesem Gerät. Bewusst **nicht** `storage.sync`, damit nichts über das Google- oder Mozilla-Konto synchronisiert wird.

## Was nicht gespeichert wird
- kein Browserverlauf, keine besuchten Seiten, keine angesehenen Videos
- keine Nutzungsdaten außer den oben genannten Zählern (und Statistik nur, wenn eingeschaltet)
- keine Kennungen, keine Cookies, kein Fingerprinting

## Netzwerk
Sirenward enthält keinen Code, der Netzwerkanfragen stellt. Zusätzlich verbietet die Content-Security-Policy der Erweiterung jede Verbindung (`connect-src 'none'`) sowie das Nachladen fremder Skripte, Bilder, Schriften und Stylesheets. Die Website-Sperre läuft über `declarativeNetRequest`: Der Browser vergleicht Adressen selbst mit deiner Liste, die Erweiterung bekommt die einzelnen Aufrufe gar nicht zu sehen.

## Berechtigungen
| Berechtigung | Wofür |
|---|---|
| `storage` | deine Einstellungen lokal speichern |
| `declarativeNetRequest` | gesperrte Websites blockieren, ohne den Datenverkehr mitzulesen |
| `activeTab` | im Popup die Adresse des aktuellen Tabs anzeigen. Nur nach deinem Klick und nur für diesen Tab |
| `alarms` | Freigaben, Zeitplan, Fokus und Sperrmodus pünktlich umschalten. Keine Installationswarnung, kein Datenzugriff |
| optional: Zugriff auf **gesperrte** Domains | nur für die eigene Sperrseite und nur, wenn du sie einschaltest. Wird pro Domain angefragt und beim Entfernen der Domain bzw. beim Abschalten automatisch wieder entzogen |
| Inhaltsskript auf `www.youtube.com` | YouTube-Elemente ausblenden und filtern. Läuft auf keiner anderen Website, hat **keinen** Zugriff auf den Speicher und bekommt nur die YouTube-Einstellungen, nicht deine Website-Liste |

Keine dauerhaften `host_permissions`, kein `tabs`, kein `history`, kein `webRequest`, kein `cookies`.

## Export und Import
Beim Export erstellt dein Browser lokal eine JSON-Datei, die du selbst speicherst. Beim Import liest die Erweiterung die von dir gewählte Datei, bereinigt den Inhalt und speichert ihn. Dabei wird nichts hochgeladen.

## Firefox
Im Manifest ist `data_collection_permissions: none` gesetzt. Firefox zeigt dir damit bei der Installation an, dass keine Daten erhoben werden.
