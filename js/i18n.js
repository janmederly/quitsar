import english from './locales/en.js';
import slovak from './locales/sk.js';
import czech from './locales/cs.js';
import german from './locales/de.js';
import spanish from './locales/es.js';
import french from './locales/fr.js';

export const languages = ['en', 'sk', 'cs', 'de', 'es', 'fr'];
const dictionaries = { en: english, sk: slovak, cs: czech, de: german, es: spanish, fr: french };
const locales = { en: 'en-GB', sk: 'sk-SK', cs: 'cs-CZ', de: 'de-DE', es: 'es-ES', fr: 'fr-FR' };
const storageKey = 'quitsar-language';
let language = 'en';
try {
  const saved = globalThis.localStorage?.getItem(storageKey);
  const preferred = globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en';
  const preferredLanguage = preferred.toLowerCase().split('-')[0];
  language = languages.includes(saved)
    ? saved
    : languages.includes(preferredLanguage)
      ? preferredLanguage
      : 'en';
} catch {
  // Translation also works when browser storage is unavailable.
}
export const getLanguage = () => language;
export const getLocale = () => locales[language];
export function setLanguage(value) {
  if (!languages.includes(value)) return;
  language = value;
  try {
    globalThis.localStorage?.setItem(storageKey, value);
  } catch {
    // The saved preferences remain the source of truth when available.
  }
  if (globalThis.document) document.documentElement.lang = language;
}

// Supports literal messages and tagged templates. Values are interpolated once,
// so imported text containing braces or translation keys remains untouched.
export function t(message, ...values) {
  const key = Array.isArray(message)
    ? message.reduce((key, part, i) => key + (i ? `{${i - 1}}` : '') + part, '')
    : message;
  const translated = dictionaries[language]?.[key] ?? key;
  return translated.replace(/\{(\d+)\}/g, (match, index) =>
    index < values.length ? String(values[index]) : match
  );
}

// Translate stored enum values only at their display boundary.
export function label(value) {
  return t(value ? value[0].toUpperCase() + value.slice(1) : '');
}
export function localizeShell() {
  document.documentElement.lang = language;
  document.title = `quitsar · ${t('Study')} & ${t('Exam simulator')}`;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  });
}
