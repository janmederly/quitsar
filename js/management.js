import { t, label, getLanguage, setLanguage } from './i18n.js';
import * as db from './storage.js';
import { LIMITS } from './limits.js';
import { signedIn, localDatabase, usesServerStorage } from './account.js';
import { el, button, badge, field, modal, date, download, table, prettyType } from './dom.js';
import { validateBank } from './validation.js';
import { readAsset, releaseAssets } from './assets.js';
import { exportBackup, validateBackup, mergePlan } from './transfer.js';
import { defaults } from './spaced-repetition.js';

const MAX_JSON = LIMITS.backup;
async function readJson(file, max = MAX_JSON) {
  if (file.size > max) throw new Error(t`${file.name}: file exceeds ${max / 1024 / 1024} MiB`);
  try {
    return JSON.parse(await file.text());
  } catch (error) {
    throw new Error(t`${file.name}: malformed JSON (${error.message})`);
  }
}
function counts(bank) {
  const types = Object.create(null);
  const topics = Object.create(null);
  for (const q of bank.questions) {
    types[q.type] = (types[q.type] || 0) + 1;
    topics[q.topicId] = (topics[q.topicId] || 0) + 1;
  }
  return { types, topics };
}
function inspect(bank) {
  const b = bank.data.bank;
  const { types, topics } = counts(bank.data);
  modal(
    b.title,
    el('p', {}, b.description || t('No description')),
    table(
      [t('Metadata'), t('Value')],
      [
        [t('Bank ID'), b.id],
        [t('Version'), b.version],
        [t('Schema'), bank.data.schemaVersion],
        [t('Language'), b.language],
        [t('Questions'), bank.data.questions.length],
        [t('Topics'), b.topics.length],
        [t('Subtopics'), b.topics.reduce((n, t) => n + (t.subtopics?.length || 0), 0)],
        [t('Imported'), date(bank.importedAt)],
        [t('State'), bank.enabled ? t('Enabled') : t('Disabled')],
        [t('Attached images'), Object.keys(bank.assets || {}).length],
        [t('Author'), b.author || '—'],
        [t('License'), b.license || '—']
      ]
    ),
    el('h3', {}, t('Question types')),
    table(
      [t('Type'), t('Count')],
      Object.entries(types).map(([t, n]) => [prettyType(t), n])
    ),
    el('h3', {}, t('Topics')),
    table(
      [t('Topic'), t('Count')],
      Object.entries(topics).map(([t, n]) => [b.topics.find((x) => x.id === t)?.title || t, n])
    ),
    bank.previousVersion && el('p', {}, t`Last update: ${bank.previousVersion} → ${b.version}`)
  );
}
async function collectAssets(files, data, old = {}) {
  const assets = { ...old };
  const paths = [...new Set(data.questions.flatMap((q) => (q.images || []).map((i) => i.path)))];
  let total = 0;
  for (const path of paths) {
    const matches = files.filter((f) => f.name === path.split('/').at(-1));
    if (matches.length > 1)
      throw new Error(
        t`Ambiguous image filename ${path}. Attach only one file with that name at a time.`
      );
    if (matches.length === 1) {
      total += matches[0].size;
      if (total > 512 * 1024)
        throw new Error(t('Selected images exceed 512 KiB. Import a smaller bank.'));
      assets[path] = await readAsset(matches[0], path);
    }
  }
  return assets;
}
export function banksView(ctx) {
  const fileInput = el('input', { type: 'file', accept: '.json', multiple: true });
  const images = el('input', {
    type: 'file',
    accept: '.svg,.png,.jpg,.jpeg,.gif,.webp',
    multiple: true
  });
  const report = el('div', { 'aria-live': 'polite' });
  let importing = false;
  async function importFiles(files, assetsFiles = []) {
    if (importing) return;
    importing = true;
    report.replaceChildren(el('p', { role: 'status' }, t('Validating selected files…')));
    try {
      for (const file of files) {
        if (!/\.json$/i.test(file.name)) {
          report.append(el('p', { class: 'notice error' }, t`${file.name}: choose a .json bank`));
          continue;
        }
        try {
          const data = await readJson(file, LIMITS.bank);
          const errors = validateBank(data);
          if (errors.length) {
            report.append(
              el(
                'section',
                { class: 'notice error' },
                el('h2', { class: 'question-subheading' }, t`Not imported: ${file.name}`),
                el('pre', {}, errors.join('\n'))
              )
            );
            continue;
          }
          const existing = await db.get('banks', data.bank.id);
          const record = {
            id: data.bank.id,
            data,
            enabled: existing?.enabled ?? true,
            assets: await collectAssets(assetsFiles, data, existing?.assets),
            importedAt: Date.now(),
            updatedAt: Date.now()
          };
          if (existing) {
            const oldIds = new Set(existing.data.questions.map((q) => q.id));
            const newIds = new Set(data.questions.map((q) => q.id));
            record.previousVersion = existing.data.bank.version;
            const yes = confirm(
              t`Update bank ${data.bank.id}?\nVersion ${existing.data.bank.version} → ${data.bank.version}\n${[...newIds].filter((id) => !oldIds.has(id)).length} added, ${[...oldIds].filter((id) => !newIds.has(id)).length} removed question IDs.\nHistory and flags are kept by bank + question ID. Existing exam snapshots stay intact. Reused IDs inherit history; use new IDs for materially different questions. Export a backup first if needed.`
            );
            if (!yes) {
              report.append(el('p', {}, t`Skipped update: ${data.bank.id}`));
              continue;
            }
          }
          await db.put('banks', record);
          const missing = data.questions
            .flatMap((q) => q.images || [])
            .filter((i) => !record.assets[i.path]).length;
          report.append(
            el(
              'p',
              { class: 'notice success' },
              t`${data.bank.title}: saved ${data.questions.length} questions.${missing ? t` ${missing} image references need attached files.` : ''}`
            )
          );
        } catch (error) {
          report.append(el('p', { class: 'notice error' }, error.message));
        }
      }
      await ctx.refresh();
      renderCards();
    } finally {
      importing = false;
    }
  }
  const cards = el('div', { class: 'bank-list' });
  function renderCards() {
    cards.replaceChildren(
      ...(ctx.banks.length
        ? ctx.banks.map((record) => {
            const b = record.data.bank;
            const { types } = counts(record.data);
            const imagePicker = el('input', {
              type: 'file',
              accept: '.svg,.png,.jpg,.jpeg,.gif,.webp',
              multiple: true,
              'aria-label': t`Attach images for ${b.title}`,
              onchange: async (event) => {
                const assets = await collectAssets(
                  [...event.target.files],
                  record.data,
                  record.assets
                );
                await db.put('banks', {
                  ...record,
                  assets,
                  updatedAt: Date.now()
                });
                releaseAssets();
                await ctx.refresh();
                renderCards();
                ctx.notice(
                  localDatabase()
                    ? t('Saved to the local database.')
                    : signedIn()
                      ? t('Selected images saved to your account.')
                      : t('Selected matching images saved locally.')
                );
              }
            });
            const missing = [
              ...new Set(record.data.questions.flatMap((q) => (q.images || []).map((i) => i.path)))
            ].filter((p) => !record.assets?.[p]);
            return el(
              'article',
              { class: 'panel bank-card' },
              el(
                'div',
                { class: 'section-heading' },
                el('h2', {}, b.title),
                badge(record.enabled ? t('Enabled') : t('Disabled'))
              ),
              el('p', {}, b.description || t('No description supplied.')),
              el(
                'p',
                { class: 'muted' },
                t`${b.id} · v${b.version} · ${b.language} · Schema ${record.data.schemaVersion}`
              ),
              record.previousVersion &&
                el(
                  'p',
                  { class: 'notice' },
                  t`Updated ${record.previousVersion} → ${b.version}; study history retained.`
                ),
              el(
                'div',
                { class: 'tags' },
                badge(t`${record.data.questions.length} questions`),
                badge(t`${b.topics.length} topics`),
                badge(t`${b.topics.reduce((n, t) => n + (t.subtopics?.length || 0), 0)} subtopics`),
                Object.entries(types).map(([t, n]) => badge(`${prettyType(t)}: ${n}`))
              ),
              el('p', { class: 'muted' }, t`Imported ${date(record.importedAt)}`),
              missing.length &&
                el('p', { class: 'notice warning' }, t`Missing images: ${missing.join(', ')}`),
              el(
                'div',
                { class: 'actions' },
                button(t('Inspect'), () => inspect(record), 'secondary'),
                button(t('Export JSON'), () => download(`${b.id}.json`, record.data), 'secondary'),
                button(
                  record.enabled ? t('Disable') : t('Enable'),
                  async () => {
                    await db.put('banks', {
                      ...record,
                      enabled: !record.enabled,
                      updatedAt: Date.now()
                    });
                    await ctx.refresh();
                    renderCards();
                  },
                  'subtle'
                ),
                button(
                  t('Delete'),
                  async () => {
                    if (
                      confirm(
                        t`Delete bank ${b.title} and its attached images? Study history and completed exam snapshots are retained. Export a full backup first to preserve the bank.`
                      )
                    ) {
                      await db.remove('banks', b.id);
                      releaseAssets();
                      await ctx.refresh();
                      renderCards();
                    }
                  },
                  'danger'
                )
              ),
              el(
                'details',
                {},
                el('summary', {}, t('Attach / replace local images')),
                el(
                  'p',
                  {},
                  t(
                    'Choose referenced image files explicitly. Basenames must be unique; matching paths are mapped from the bank.'
                  )
                ),
                imagePicker
              )
            );
          })
        : [
            el(
              'div',
              { class: 'panel empty' },
              el('h2', {}, t('Your library starts here.')),
              el(
                'p',
                {},
                t('Import a bank or load the included demo. Nothing is loaded automatically.')
              )
            )
          ])
    );
  }
  async function loadDemo() {
    report.replaceChildren(el('p', { role: 'status' }, t('Loading included local demo…')));
    const response = await fetch('./banks/demo.json');
    if (!response.ok)
      throw new Error(
        t('Included demo unavailable. Start the local server from the project root.')
      );
    const data = await response.json();
    const errors = validateBank(data);
    if (errors.length) throw new Error(errors.join('\n'));
    const existing = await db.get('banks', data.bank.id);
    if (existing && !confirm(t('Reload the demo bank? Study history is preserved.'))) return;
    const assets = {};
    // Explicit allowlist: never turn arbitrary imported paths into network requests.
    for (const path of [
      'images/annulus.svg',
      'images/history-timeline.svg',
      'images/cell-diagram.svg'
    ]) {
      const response = await fetch(`./banks/${path}`);
      if (!response.ok) throw new Error(t`Included image unavailable: ${path}`);
      assets[path] = await readAsset(await response.blob(), path);
    }
    await db.put('banks', {
      id: data.bank.id,
      data,
      assets,
      enabled: true,
      importedAt: Date.now(),
      updatedAt: Date.now()
    });
    await ctx.refresh();
    renderCards();
    report.replaceChildren(
      el(
        'p',
        { class: 'notice success' },
        localDatabase()
          ? t('Saved to the local database.')
          : signedIn()
            ? t('Demo saved to your account with all images.')
            : t('Demo saved locally with all images.')
      )
    );
  }
  const drop = el(
    'section',
    {
      class: 'panel import-panel',
      ondragover: (e) => {
        e.preventDefault();
      },
      ondrop: (e) => {
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        importFiles(
          files.filter((f) => /\.json$/i.test(f.name)),
          files.filter((f) => /\.(svg|png|jpe?g|gif|webp)$/i.test(f.name))
        );
      }
    },
    el('h2', {}, t('Bring your own questions')),
    el(
      'p',
      {},
      t(
        'Choose JSON banks (up to 512 KiB) and images (256 KiB each, 512 KiB combined). A saved bank including images must fit in 1 MiB. Account storage: 20 MiB total. You can also drop selected files here.'
      )
    ),
    el(
      'div',
      { class: 'two-column' },
      field(t('Question bank JSON files'), fileInput),
      field(t('Related image files (optional)'), images)
    ),
    el(
      'div',
      { class: 'actions' },
      button(
        t('Validate & import'),
        () => {
          if (!fileInput.files.length) {
            ctx.notice(t('Select at least one bank JSON file.'), 'error');
            return;
          }
          importFiles([...fileInput.files], [...images.files]);
        },
        'primary'
      ),
      button(t('Load included demo bank'), loadDemo, 'secondary')
    ),
    report
  );
  ctx.show(
    ctx.title(
      t('YOUR LIBRARY'),
      t('Question banks'),
      localDatabase()
        ? t('All study data is saved on this server. Export backups regularly.')
        : signedIn()
          ? t('Your curriculum, saved privately to your account.')
          : t('Your curriculum, stored only in this browser.')
    ),
    drop,
    cards
  );
  renderCards();
}

export function toolsView(ctx) {
  const input = el('input', { type: 'file', accept: '.json' });
  const preview = el('div', { 'aria-live': 'polite' });
  let incoming = null;
  let plan = null;
  const confirmButton = button(
    t('Confirm merge'),
    async () => {
      if (!incoming) return;
      const current = {};
      for (const name of db.STORES) current[name] = await db.all(name);
      plan = mergePlan(incoming, current);
      await db.restoreChanges(plan.changes);
      incoming = null;
      await ctx.refresh();
      releaseAssets();
      preview.replaceChildren(
        el(
          'p',
          { class: 'notice success' },
          localDatabase()
            ? t('Saved to the local database.')
            : signedIn()
              ? t('Restore complete. Records merged into your account.')
              : t('Restore complete. Records merged into local storage.')
        )
      );
      confirmButton.disabled = true;
    },
    'primary',
    { disabled: true }
  );
  const check = async () => {
    confirmButton.disabled = true;
    incoming = null;
    if (!input.files.length) {
      ctx.notice(t('Choose a backup or study-data JSON file.'), 'error');
      return;
    }
    preview.replaceChildren(el('p', { role: 'status' }, t('Checking backup…')));
    try {
      incoming = await validateBackup(await readJson(input.files[0]));
      const current = {};
      for (const name of db.STORES) current[name] = await db.all(name);
      plan = mergePlan(incoming, current);
      preview.replaceChildren(
        el('h3', {}, t('Ready to merge')),
        table(
          [t('Action'), t('Records')],
          [
            [t('Add'), plan.stats.added],
            [t('Update newer records'), plan.stats.updated],
            [t('Skip existing / older duplicates'), plan.stats.skipped],
            [t('Existing bank identities kept'), plan.stats.bankConflicts]
          ]
        ),
        el(
          'p',
          {},
          t(
            'Nothing changes until you confirm. Bank conflicts keep the current bank; import the bank JSON separately to explicitly update it. States, settings and attempts use the newest timestamp. History merges by event ID. Existing interrupted exams are kept. No records are deleted.'
          )
        )
      );
      confirmButton.disabled = false;
    } catch (error) {
      preview.replaceChildren(el('p', { class: 'notice error', role: 'alert' }, error.message));
    }
  };
  ctx.show(
    ctx.title(
      t('KEEP A SECOND COPY'),
      t('Backup & export'),
      t('Downloads happen only when you ask. Choose their destination in your browser.')
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Export your data')),
      el(
        'p',
        {},
        t(
          'Full backups include banks, sanitized attached images, study history, schedules, flags, results, settings and any interrupted exam. Study exports include history and schedules only.'
        )
      ),
      el(
        'div',
        { class: 'actions' },
        button(t('Download full backup'), () => exportBackup(), 'primary'),
        button(t('Download study history'), () => exportBackup(true), 'secondary'),
        button(t('Export an exam attempt'), () => ctx.navigate('results'), 'secondary')
      )
    ),
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Restore a backup')),
      field(t('Backup or study-data JSON'), input),
      el(
        'div',
        { class: 'actions' },
        button(t('Validate & preview merge'), check, 'secondary'),
        confirmButton
      ),
      preview
    ),
    el(
      'section',
      { class: 'notice' },
      el('h2', {}, t('Your browser is your notebook.')),
      el(
        'p',
        {},
        t(
          localDatabase()
            ? 'All study data is saved on this server. Export backups regularly.'
            : 'Guest libraries belong to this browser and origin. Account libraries are available after signing in on another device and need a connection. Guest and account data are separate. Download backups regularly. Bank-only JSON exports omit images; full backups include them. Backup restores upload in smaller parts and merge atomically, up to 24 MiB or 150,000 records.'
        )
      )
    )
  );
}

export function settingsView(ctx) {
  const controls = {};
  const s = ctx.settings;
  const num = (key, label, hint, min = 1, max = 5256000) => {
    const input = el('input', {
      type: 'number',
      value: s[key],
      required: true,
      min,
      max,
      step: key === 'multiplier' ? '0.1' : '1'
    });
    controls[key] = input;
    return field(label, input, hint);
  };
  controls.language = el(
    'select',
    {},
    el('option', { value: 'en', selected: getLanguage() === 'en' }, 'English'),
    el('option', { value: 'sk', selected: getLanguage() === 'sk' }, 'Slovenčina'),
    el('option', { value: 'cs', selected: getLanguage() === 'cs' }, 'Čeština'),
    el('option', { value: 'de', selected: getLanguage() === 'de' }, 'Deutsch'),
    el('option', { value: 'es', selected: getLanguage() === 'es' }, 'Español'),
    el('option', { value: 'fr', selected: getLanguage() === 'fr' }, 'Français')
  );
  controls.theme = el(
    'select',
    {},
    ['system', 'light', 'dark'].map((v) =>
      el('option', { value: v, selected: s.theme === v }, label(v))
    )
  );
  controls.warnings = el('input', { value: s.warnings, required: true, pattern: '[0-9., ]+' });
  controls.scoring = el(
    'select',
    {},
    ['both', 'strict', 'partial'].map((v) =>
      el('option', { value: v, selected: s.scoring === v }, label(v))
    )
  );
  controls.explanations = el('input', { type: 'checkbox', checked: s.explanations });
  const form = el(
    'form',
    {
      class: 'panel',
      onsubmit: async (e) => {
        e.preventDefault();
        const next = { ...s, id: 'preferences', updatedAt: Date.now() };
        for (const [k, v] of Object.entries(controls))
          next[k] =
            v.type === 'checkbox' ? v.checked : v.type === 'number' ? Number(v.value) : v.value;
        if (
          next.maximumInterval < next.minimumInterval ||
          !/^\s*\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*\s*$/.test(next.warnings) ||
          next.warnings.split(',').some((n) => Number(n) > 1440)
        ) {
          ctx.notice(
            t('Use a maximum ≥ minimum interval and comma-separated warning minutes from 0–1440.'),
            'error'
          );
          return;
        }
        const languageChanged = next.language !== getLanguage();
        await db.put('settings', next);
        setLanguage(next.language);
        if (languageChanged) {
          location.reload();
          return;
        }
        await ctx.refresh();
        ctx.notice(
          localDatabase()
            ? t('Saved to the local database.')
            : signedIn()
              ? t('Preferences saved to your account.')
              : t('Preferences saved locally.')
        );
      }
    },
    el('h2', {}, t('Reading & appearance')),
    field(t('Interface language'), controls.language),
    field(t('Theme'), controls.theme),
    el('h2', {}, t('Transparent spaced repetition')),
    el(
      'p',
      {},
      t(
        'All intervals below are in minutes. Repeat quarters the previous interval; Know multiplies it. Both are clamped to the minimum and maximum.'
      )
    ),
    el(
      'div',
      { class: 'filter-grid' },
      num('initialRepeat', t('First Repeat interval'), t('Default: 10 minutes')),
      num('initialKnow', t('First Know interval'), t('Default: 1 day = 1440 minutes')),
      num('minimumInterval', t('Minimum interval'), t('Lower bound for every review')),
      num('multiplier', t('Know interval multiplier'), t('For later Know responses'), 1, 10),
      num('maximumInterval', t('Maximum interval'), t('Default: 180 days = 259200 minutes'))
    ),
    el('h2', {}, t('Exam defaults')),
    el(
      'div',
      { class: 'filter-grid' },
      field(t('Timer warning minutes'), controls.warnings, t('Comma-separated, e.g. 10,5,1')),
      field(t('Default scoring display'), controls.scoring)
    ),
    el(
      'label',
      { class: 'checkbox-row' },
      controls.explanations,
      t('Hide explanations until final submission by default')
    ),
    el('button', { type: 'submit', class: 'primary' }, t('Save settings'))
  );
  async function erase(kind) {
    if (ctx.active) {
      ctx.notice(t('Resume or discard the interrupted exam before clearing data.'), 'error');
      return;
    }
    const description = {
      study: t('all study history, schedules, flags and review state'),
      attempts: t('all completed exam attempts'),
      banks: t('all imported banks and attached images')
    }[kind];
    const dialog = modal(
      signedIn() ? t('Clear account data?') : t('Clear local data?'),
      el('p', {}, t`Permanently delete ${description}? This cannot be undone.`),
      el(
        'div',
        { class: 'actions' },
        button(t('Download full backup first'), () => exportBackup(), 'secondary'),
        button(
          t('Delete this data'),
          async () => {
            const stores =
              kind === 'study'
                ? ['states', 'history']
                : kind === 'attempts'
                  ? ['attempts']
                  : ['banks'];
            await db.clearStores(stores);
            await ctx.refresh();
            releaseAssets();
            dialog.close();
            ctx.notice(
              signedIn() ? t('Selected account data cleared.') : t('Selected local data cleared.')
            );
            settingsView(ctx);
          },
          'danger'
        )
      )
    );
  }
  ctx.show(
    ctx.title(t('MAKE IT YOURS'), t('Settings'), t('A comfortable space for long study sessions.')),
    form,
    el(
      'section',
      { class: 'panel' },
      el('h2', {}, t('Storage & privacy')),
      el(
        'p',
        {},
        t(
          localDatabase()
            ? 'All study data is saved on this server. Export backups regularly.'
            : 'Guest data stays in this browser’s IndexedDB. Signed-in data is stored privately in Cloudflare D1 and requires a connection. Google verifies your identity; there are no analytics. Guest and account libraries are separate. To move data, export a guest backup, sign in, and import it. Account restores are atomic, limited to 2 MiB per transaction. Each record is limited to 1 MiB; accounts have 20 MiB and 20,000 records.'
        )
      ),
      el(
        'div',
        { class: 'actions' },
        button(t('Download full backup'), () => exportBackup(), 'secondary'),
        !usesServerStorage() &&
          navigator.storage?.persist &&
          button(
            t('Request persistent browser storage'),
            async () => {
              const granted = await navigator.storage.persist();
              ctx.notice(
                granted
                  ? t('Browser granted persistent storage. Keep backups too.')
                  : t('Browser did not grant persistence. Downloads remain your reliable backup.')
              );
            },
            'secondary'
          )
      ),
      el('h3', {}, t('Clear selected data')),
      el(
        'p',
        {},
        t(
          'Clearing banks retains history and exam question snapshots. Clearing study data does not change completed exam results.'
        )
      ),
      el(
        'div',
        { class: 'actions' },
        button(t('Clear study history'), () => erase('study'), 'danger'),
        button(t('Clear attempts'), () => erase('attempts'), 'danger'),
        button(t('Clear imported banks'), () => erase('banks'), 'danger')
      )
    ),
    el(
      'p',
      { class: 'muted' },
      t`Default intervals: Repeat ${defaults.initialRepeat} min · Know ${defaults.initialKnow} min. No Anki or SM-2 compatibility is claimed.`
    )
  );
}
