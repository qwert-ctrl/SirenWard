/*
 * Sirenward – translations for extension pages (popup, settings, block page).
 * Texts come from _locales/<lang>/messages.json via chrome.i18n (English is the fallback).
 * Only textContent/attributes are set – compatible with the Trusted Types policy.
 *   <span data-i18n="…">                  → textContent
 *   data-i18n-placeholder / -aria-label / -title="key" → attribute
 */
(function (root) {
  'use strict';

  /** Translate a key; substitutions replace $1…$9. Falls back to the key so gaps are visible. */
  function t(key, ...subs) {
    let m = '';
    try {
      m = chrome.i18n.getMessage(key, subs.map(String));
    } catch {
      m = '';
    }
    return m || key;
  }

  // Language actually shown (en/de), not just the browser language
  const lang = t('localeCode') === 'localeCode' ? 'en' : t('localeCode');
  // Date/time format: the browser's regional variant if it matches the shown language (e.g. en-GB, de-AT)
  const nav = (typeof navigator !== 'undefined' && navigator.language) || lang;
  const locale = nav.toLowerCase().startsWith(lang) ? nav : lang;

  const ATTRS = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-title', 'title'],
  ];

  function apply(scope) {
    const rootEl = scope || document;
    for (const el of rootEl.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    for (const [data, attr] of ATTRS) {
      for (const el of rootEl.querySelectorAll('[' + data + ']')) el.setAttribute(attr, t(el.getAttribute(data)));
    }
  }

  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    apply(document);
  }

  root.FGi18n = Object.freeze({ t, lang, locale, apply });
})(globalThis);
