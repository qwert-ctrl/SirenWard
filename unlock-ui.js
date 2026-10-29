/*
 * Sirenward – Freigabe-Baustein (Popup und Sperrseite).
 * Ablauf: "15 min freigeben" → Wartezeit läuft UND Satz abtippen (nur Buchstaben zählen) → Bestätigen.
 * Die Prüfung von Wartezeit, Satz und Tageslimit passiert im Hintergrund – die Oberfläche hilft nur.
 */
(function (root) {
  'use strict';
  const FG = root.FG;
  const { h, fmtLeft, fmtTime } = root.FGClient;

  /**
   * @param el       Container
   * @param domain   Eintrag der Sperrliste (z. B. "reddit.com")
   * @param view     { settings, state } aus FGClient.status()
   * @param hooks    { onChange(result), onUnlocked(result), say(text, isError) }
   * @returns        Aufräumfunktion (stoppt Timer)
   */
  function renderUnlock(el, domain, view, hooks) {
    const { settings, state } = view;
    const say = hooks.say || (() => {});
    let timer = 0;
    el.replaceChildren();
    if (!state) return () => {};

    const tick = (fn) => {
      fn();
      timer = setInterval(fn, 1000);
    };
    const run = async (op) => {
      const r = await root.FGClient.op(op);
      if (!r.ok) say(r.message, true);
      hooks.onChange && hooks.onChange(r);
      return r;
    };

    const unlockedUntil = state.unlocks[domain];
    const blocked = state.blocking.blocked.includes(domain);
    const used = state.used[domain] || 0;
    const left = Math.max(0, settings.unlock.perDay - used);

    // 1) Gerade freigegeben
    if (unlockedUntil && state.blocking.unlocked.includes(domain)) {
      const line = h('p', 'unlock-line');
      const again = h('button', 'secondary', 'Jetzt wieder sperren');
      again.type = 'button';
      again.addEventListener('click', () => run({ op: 'unlockEnd', domain }));
      el.append(line, again);
      tick(() => {
        const rest = unlockedUntil - Date.now();
        line.textContent = rest > 0 ? `Frei bis ${fmtTime(unlockedUntil)} – noch ${fmtLeft(rest)}` : 'Freigabe abgelaufen.';
      });
      return () => clearInterval(timer);
    }

    // 2) Fokus-Sitzung
    if (state.blocking.focus) {
      const line = h('p', 'unlock-line');
      el.append(line);
      tick(() => (line.textContent = `Fokus-Sitzung – noch ${fmtLeft(state.focusUntil - Date.now())}. Keine Freigaben.`));
      return () => clearInterval(timer);
    }

    // 3) Gerade nicht gesperrt (z. B. außerhalb des Zeitplans)
    if (!blocked) {
      el.append(h('p', 'unlock-line', 'Gerade nicht gesperrt (außerhalb deines Zeitplans).'));
      return () => {};
    }

    // 4) Kein Kontingent mehr
    if (left <= 0) {
      el.append(
        h('p', 'unlock-line', settings.unlock.perDay === 0 ? 'Freigaben sind ausgeschaltet.' : `Heute keine Freigaben mehr (${used} von ${settings.unlock.perDay} genutzt).`)
      );
      return () => {};
    }

    const readyAt = state.pending[domain];

    // 5) Noch nicht angefragt
    if (!readyAt) {
      const btn = h('button', null, `${settings.unlock.minutes} min freigeben`);
      btn.type = 'button';
      const note = h('p', 'muted small', `Noch ${left} von ${settings.unlock.perDay} Freigaben heute.`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        await run({ op: 'unlockRequest', domain });
      });
      el.append(btn, note);
      return () => {};
    }

    // 6) Angefragt: Wartezeit + Satz abtippen
    const phrase = settings.unlock.phrase;
    const wait = h('p', 'unlock-line');
    const label = h('label', 'unlock-label');
    label.append(h('span', 'muted small', 'Tippe ab:'), h('q', 'unlock-phrase', phrase));
    const input = h('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', 'Satz abtippen: ' + phrase);
    // Bewusst tippen statt einfügen
    for (const ev of ['paste', 'drop']) input.addEventListener(ev, (e) => e.preventDefault());
    const actions = h('div', 'row');
    const ok = h('button', null, 'Freigeben');
    ok.type = 'button';
    const cancel = h('button', 'secondary', 'Abbrechen');
    cancel.type = 'button';
    actions.append(ok, cancel);
    el.append(wait, label, input, actions);

    const refresh = () => {
      const rest = readyAt - Date.now();
      const matches = FG.phraseMatches(input.value, phrase);
      wait.textContent = rest > 0 ? `Wartezeit: noch ${fmtLeft(rest)}` : 'Wartezeit vorbei.';
      input.classList.toggle('ok', matches);
      ok.disabled = rest > 0 || !matches;
    };
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !ok.disabled) ok.click();
    });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const r = await run({ op: 'unlockConfirm', domain, phrase: input.value });
      if (r.ok && hooks.onUnlocked) hooks.onUnlocked(r);
    });
    cancel.addEventListener('click', () => run({ op: 'unlockCancel', domain }));
    tick(refresh);
    setTimeout(() => input.focus({ preventScroll: true }), 0);
    return () => clearInterval(timer);
  }

  root.FGUnlock = Object.freeze({ renderUnlock });
})(globalThis);
