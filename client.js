/*
 * FocusGuard – Client für Erweiterungsseiten (Popup, Einstellungen).
 * Seiten schreiben nie selbst in den Speicher, sondern schicken Befehle an den Hintergrund.
 */
(function (root) {
  'use strict';
  const FG = root.FG;

  const ERRORS = {
    locked: 'Während der Sperre nicht möglich – Regeln können nur verschärft werden.',
    invalid: 'Ungültige Eingabe.',
    forbidden: 'Nicht erlaubt.',
    internal: 'Interner Fehler – bitte erneut versuchen.',
    unreachable: 'Hintergrunddienst nicht erreichbar – bitte erneut versuchen.',
  };

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r && typeof r === 'object' ? r : { ok: false, error: 'unreachable' };
    } catch {
      return { ok: false, error: 'unreachable' };
    }
  }

  const FGClient = Object.freeze({
    ERRORS,
    async get() {
      const r = await send({ type: 'fg:get' });
      return FG.withDefaults(r.ok ? r.settings : null);
    },
    /** @returns {ok, error?, message?, invalid?, partial?, settings?} */
    async op(op) {
      const r = await send({ type: 'fg:op', op });
      if (r.settings) r.settings = FG.withDefaults(r.settings);
      if (!r.ok) r.message = ERRORS[r.error] || ERRORS.internal;
      return r;
    },
    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) cb(FG.withDefaults(changes.settings.newValue));
      });
    },
  });

  root.FGClient = FGClient;
})(globalThis);
