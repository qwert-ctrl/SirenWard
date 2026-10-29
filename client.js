/*
 * SirenWard – Client für Erweiterungsseiten (Popup, Einstellungen, Sperrseite).
 * Seiten schreiben nie selbst in den Speicher, sondern schicken Befehle an den Hintergrund.
 * Enthält außerdem kleine, Trusted-Types-sichere UI-Helfer (nur createElement/textContent).
 */
(function (root) {
  'use strict';
  const FG = root.FG;

  const { t, locale } = root.FGi18n;
  // Fehlercodes des Hintergrunds → Texte in _locales (err_<code>)
  const ERROR_CODES = Object.freeze(['locked', 'partner', 'badcode', 'cooldown', 'invalid', 'forbidden', 'quota', 'wait', 'phrase', 'focus', 'notBlocked', 'noRequest', 'clock', 'disabled', 'internal', 'unreachable']);

  const fmtTime = (ms) => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(ms));
  const fmtDateTime = (ms) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r && typeof r === 'object' ? r : { ok: false, error: 'unreachable' };
    } catch {
      return { ok: false, error: 'unreachable' };
    }
  }

  function message(r) {
    if (r.error === 'cooldown' && r.retryAt) return t('err_cooldownUntil', fmtTime(r.retryAt));
    return t('err_' + (ERROR_CODES.includes(r.error) ? r.error : 'internal'));
  }

  /** Modaler Dialog für den Partner-Code. @returns Promise<string|null> */
  function askCode(text) {
    return new Promise((resolve) => {
      const dlg = h('dialog', 'fg-dialog');
      const form = h('form');
      form.method = 'dialog';
      const title = h('h2', null, t('dialogTitle'));
      const p = h('p', 'muted', text || t('dialogText'));
      const input = h('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.required = true;
      input.minLength = FG.LIMITS.CODE_MIN;
      input.maxLength = FG.LIMITS.CODE_MAX;
      input.setAttribute('aria-label', t('dialogTitle'));
      const row = h('div', 'row end');
      const cancel = h('button', null, t('cancel'));
      cancel.type = 'button';
      const ok = h('button', 'primary', t('confirm'));
      ok.type = 'submit';
      row.append(cancel, ok);
      form.append(title, p, input, row);
      dlg.append(form);
      document.body.append(dlg);
      let value = null;
      cancel.addEventListener('click', () => dlg.close());
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input.reportValidity()) return;
        value = input.value;
        dlg.close();
      });
      dlg.addEventListener('close', () => {
        dlg.remove();
        resolve(value);
      });
      dlg.showModal();
      input.focus();
    });
  }

  /** UI-Sicht: bereinigt, Partner nur als Flag (der Hash erreicht die Oberfläche nie). */
  function fromUi(raw) {
    const s = FG.withDefaults(raw);
    s.partner = { enabled: !!(raw && raw.partner && raw.partner.enabled === true) };
    return s;
  }

  function normalizeResult(r) {
    if (r.settings) r.settings = fromUi(r.settings);
    if (!r.ok) r.message = message(r);
    return r;
  }

  const FGClient = Object.freeze({
    ERROR_CODES,
    h,
    fmtTime,
    fmtDateTime,
    fmtLeft,
    askCode,
    /** Einstellungen + Laufzeitzustand */
    async status() {
      const r = await send({ type: 'fg:get' });
      return { settings: fromUi(r.ok ? r.settings : null), state: r.ok ? r.state : null };
    },
    async get() {
      return (await this.status()).settings;
    },
    /**
     * Befehl senden. Verlangt er den Partner-Code, wird dieser abgefragt und der Befehl wiederholt.
     * @returns {ok, error?, message?, invalid?, partial?, info?, settings?, state?}
     */
    async op(op, { interactive = true } = {}) {
      let r = normalizeResult(await send({ type: 'fg:op', op }));
      while (interactive && !r.ok && (r.error === 'partner' || r.error === 'badcode') && typeof document !== 'undefined') {
        const code = await askCode(r.error === 'badcode' ? t('dialogRetry') : undefined);
        if (code === null) {
          r.message = t('cancelled');
          break;
        }
        r = normalizeResult(await send({ type: 'fg:op', op, code }));
      }
      return r;
    },
    onChange(cb) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) cb(fromUi(changes.settings.newValue));
      });
    },
    onStateChange(cb) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes._state || changes.settings)) cb();
      });
    },
  });

  root.FGClient = FGClient;
})(globalThis);
