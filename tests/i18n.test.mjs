import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLanguage, getLanguage, getLocale, languages } from '../js/i18n.js';
import slovak from '../js/locales/sk.js';
import czech from '../js/locales/cs.js';
import german from '../js/locales/de.js';
import spanish from '../js/locales/es.js';
import french from '../js/locales/fr.js';
import { validateBank } from '../js/validation.js';
import { validateBackup } from '../js/transfer.js';
import { defaults } from '../js/spaced-repetition.js';

test('Slovak messages interpolate values without translating imported content', () => {
  setLanguage('sk');
  assert.equal(getLocale(), 'sk-SK');
  assert.equal(t('Settings'), 'Nastavenia');
  assert.equal(t`Question ${2} of ${10}`, 'Otázka 2 z 10');
  assert.equal(t`Banks: ${'Settings {0} <script>'}`, 'Banky: Settings {0} <script>');
  assert.equal(t('Unknown message'), 'Unknown message');
  setLanguage('invalid');
  assert.equal(getLanguage(), 'sk');
  setLanguage('en');
  assert.equal(t`Question ${2} of ${10}`, 'Question 2 of 10');
});

test('Czech messages interpolate values without translating imported content', () => {
  setLanguage('cs');
  assert.equal(getLocale(), 'cs-CZ');
  assert.equal(t('Settings'), 'Nastavení');
  assert.equal(t`Question ${2} of ${10}`, 'Otázka 2 z 10');
  assert.equal(t`Banks: ${'Settings {0} <script>'}`, 'Banky: Settings {0} <script>');
  assert.equal(t('Unknown message'), 'Unknown message');
  setLanguage('invalid');
  assert.equal(getLanguage(), 'cs');
  setLanguage('en');
  assert.equal(t`Question ${2} of ${10}`, 'Question 2 of 10');
});

test('Slovak translations have no unresolved or introduced placeholders', () => {
  setLanguage('sk');
  for (const [key, value] of Object.entries(slovak)) {
    assert.ok(value.trim(), key);
    const source = new Set(key.match(/\{\d+\}/g) || []);
    for (const placeholder of value.match(/\{\d+\}/g) || []) {
      assert.ok(source.has(placeholder), key);
    }
  }
  assert.deepEqual(validateBank(null), ['$: musí byť objekt JSON']);
  setLanguage('en');
});

test('Czech covers the full catalog and preserves interpolation placeholders', () => {
  assert.deepEqual(Object.keys(czech).sort(), Object.keys(slovak).sort());
  setLanguage('cs');
  try {
    for (const [key, value] of Object.entries(czech)) {
      assert.ok(value.trim(), key);
      const placeholders = (text) => new Set(text.match(/\{\d+\}/g) || []);
      const source = placeholders(key);
      const translated = placeholders(value);
      for (const placeholder of translated) assert.ok(source.has(placeholder), key);
      // The English plural suffix is intentionally replaced by Czech wording.
      if (key === 'Timer warning: {0} minute{1} or less remain.') source.delete('{1}');
      assert.deepEqual(translated, source, key);
    }
    assert.deepEqual(validateBank(null), ['$: musí být objekt JSON']);
  } finally {
    setLanguage('en');
  }
});

test('backups support saved language choices and older preferences', async () => {
  const backup = (preferences) => ({
    format: 'quitsar-backup',
    version: 1,
    records: { settings: [{ ...defaults, id: 'preferences', updatedAt: 1, ...preferences }] }
  });
  await validateBackup(backup({}));
  for (const language of languages) {
    const restored = await validateBackup(backup({ language }));
    assert.equal(restored.settings[0].language, language);
  }
  await assert.rejects(validateBackup(backup({ language: 'unsupported' })), /Invalid preferences/);
});

for (const [language, dictionary, locale, settings, question, validation] of [
  ['de', german, 'de-DE', 'Einstellungen', 'Frage 2 von 10', '$: muss ein JSON-Objekt sein'],
  ['es', spanish, 'es-ES', 'Ajustes', 'Pregunta 2 de 10', '$: debe ser un objeto JSON'],
  ['fr', french, 'fr-FR', 'Paramètres', 'Question 2 sur 10', '$ : doit être un objet JSON']
]) {
  test(`${language} covers the full catalog and preserves interpolation placeholders`, () => {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(slovak).sort());
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(value.trim(), key);
      const placeholders = (text) => new Set(text.match(/\{\d+\}/g) || []);
      const source = placeholders(key);
      // Replace the English plural suffix with a language-neutral abbreviation.
      if (key === 'Timer warning: {0} minute{1} or less remain.') source.delete('{1}');
      assert.deepEqual(placeholders(value), source, key);
    }
    setLanguage(language);
    try {
      assert.equal(getLocale(), locale);
      assert.equal(t('Settings'), settings);
      assert.equal(t`Question ${2} of ${10}`, question);
      assert.ok(t`Banks: ${'Settings {0} <script>'}`.endsWith('Settings {0} <script>'));
      assert.deepEqual(validateBank(null), [validation]);
      assert.equal(t('Unknown message'), 'Unknown message');
      setLanguage('invalid');
      assert.equal(getLanguage(), language);
    } finally {
      setLanguage('en');
    }
  });
}
