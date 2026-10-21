import * as db from './storage.js';
import { t } from './i18n.js';
import { validateBank } from './validation.js';
import { readAsset } from './assets.js';

export const DEMO_ID = 'quitsar-biology-demo';
export const DEMO_VERSION = '1.1.0';
const images = ['images/animal-cell.webp', 'images/food-chain.webp'];

export async function loadDemoBank() {
  const response = await fetch('./banks/demo.json');
  if (!response.ok)
    throw new Error(t('Included demo unavailable. Start the local server from the project root.'));
  const data = await response.json();
  const errors = validateBank(data);
  if (errors.length) throw new Error(errors.join('\n'));
  const assets = {};
  // Only bundled image paths may be fetched. Imported banks still need selected files.
  for (const path of images) {
    const response = await fetch(`./banks/${path}`);
    if (!response.ok) throw new Error(t`Included image unavailable: ${path}`);
    assets[path] = await readAsset(await response.blob(), path);
  }
  const now = Date.now();
  return { id: data.bank.id, data, assets, enabled: true, importedAt: now, updatedAt: now };
}

export async function ensureDefaultDemo() {
  const banks = await db.all('banks');
  const previous =
    banks.length === 1 && banks[0].id === DEMO_ID && banks[0].isDefaultDemo ? banks[0] : null;
  if (banks.length && (!previous || previous.data.bank.version === DEMO_VERSION)) return;
  const record = await loadDemoBank();
  // Recheck after fetching so an import in another tab is never replaced.
  const current = await db.all('banks');
  if (!current.length) await db.put('banks', { ...record, isDefaultDemo: true });
  else if (
    previous &&
    current.length === 1 &&
    current[0].id === DEMO_ID &&
    current[0].isDefaultDemo &&
    current[0].updatedAt === previous.updatedAt
  )
    await db.put('banks', {
      ...record,
      // Saved exams may still reference an earlier demo image by its old path.
      assets: { ...previous.assets, ...record.assets },
      enabled: previous.enabled,
      importedAt: previous.importedAt,
      isDefaultDemo: true
    });
}

export async function removeReplacedDemo(banks) {
  const defaults = banks.filter((bank) => bank.id === DEMO_ID && bank.isDefaultDemo);
  if (!defaults.length || !banks.some((bank) => bank.id !== DEMO_ID)) return banks;
  await db.atomic(defaults.map((bank) => ({ store: 'banks', id: bank.id, delete: true })));
  return banks.filter((bank) => !defaults.includes(bank));
}
