import { t } from './i18n.js';
import { usesServerStorage, api } from './account.js';
import { LIMITS, jsonBytes } from './limits.js';
export const STORES = ['banks', 'states', 'attempts', 'history', 'settings', 'active'];
let database;
let writes = 0;
globalThis.addEventListener?.('beforeunload', (event) => {
  if (writes) {
    event.preventDefault();
    event.returnValue = t('Local changes are still saving.');
  }
});
function transactionFor(stores, mode) {
  if (mode === 'readonly') return database.transaction(stores, mode);
  try {
    return database.transaction(stores, mode, { durability: 'strict' });
  } catch {
    return database.transaction(stores, mode);
  }
}
export async function openStorage() {
  if (usesServerStorage()) return;
  if (!globalThis.indexedDB)
    throw new Error(
      t(
        'IndexedDB is unavailable. Enable browser site storage or use a normal browser window. Your data needs local storage to work safely.'
      )
    );
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('quitsar', 1);
    request.onupgradeneeded = () => {
      // Future internal migrations belong here; never discard stores during upgrades.
      for (const name of STORES)
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error(t('Storage upgrade is blocked. Close other quitsar tabs and reload.')));
  });
  database.onversionchange = () => database.close();
  await put(
    'settings',
    (await get('settings', 'storage-check')) || { id: 'storage-check', value: 1 }
  );
}
function request(store, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = transactionFor(store, mode);
    if (mode === 'readwrite') writes++;
    const operation = action(transaction.objectStore(store));
    transaction.oncomplete = () => {
      if (mode === 'readwrite') writes--;
      resolve(operation?.result);
    };
    transaction.onabort = () => {
      if (mode === 'readwrite') writes--;
      reject(
        transaction.error ||
          operation?.error ||
          new Error(t('Could not save local data. Check storage permissions and free disk space.'))
      );
    };
    transaction.onerror = () => {};
  });
}
export const get = (store, id) =>
  usesServerStorage()
    ? api(`/api/records?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`)
    : request(store, 'readonly', (s) => s.get(id));
export const all = (store) =>
  usesServerStorage()
    ? api(`/api/records?store=${encodeURIComponent(store)}`)
    : request(store, 'readonly', (s) => s.getAll());
export const put = async (store, value) => {
  if (jsonBytes(value) > LIMITS.record)
    throw new Error(t('Record exceeds 1 MiB. Split the bank or use smaller images/exams.'));
  return usesServerStorage()
    ? api('/api/records', { changes: [{ store, value }] })
    : request(store, 'readwrite', (s) => s.put(value));
};
export const remove = (store, id) =>
  usesServerStorage()
    ? api('/api/records', { changes: [{ store, id, delete: true }] })
    : request(store, 'readwrite', (s) => s.delete(id));
export const clear = (store) =>
  usesServerStorage()
    ? api('/api/records', { clear: store })
    : request(store, 'readwrite', (s) => s.clear());
export async function clearStores(stores) {
  if (usesServerStorage()) return api('/api/records', { clearStores: stores });
  const changes = [];
  for (const store of stores)
    for (const row of await all(store)) changes.push({ store, delete: true, id: row.id });
  return atomic(changes);
}
// Use bounded uploads for backups while keeping their final merge atomic.
export async function restoreChanges(changes) {
  if (!usesServerStorage() || !changes.length) return atomic(changes);
  const chunks = [];
  let chunk = [];
  let bytes = 2;
  let total = 0;
  for (const change of changes) {
    if (!change.delete && jsonBytes(change.value) > LIMITS.record)
      throw new Error(t('Record exceeds 1 MiB. Split the bank or use smaller images/exams.'));
    const size = jsonBytes(change) + 1;
    if (chunk.length && (bytes + size > 1400000 || chunk.length >= LIMITS.changes)) {
      chunks.push(chunk);
      total += bytes;
      chunk = [];
      bytes = 2;
    }
    chunk.push(change);
    bytes += size;
  }
  if (chunk.length) {
    chunks.push(chunk);
    total += bytes;
  }
  if (total > LIMITS.backup || changes.length > 150000 || chunks.length > 128)
    throw new Error(t('Restore exceeds 24 MiB or 150,000 records.'));
  const { id } = await api('/api/restore', { action: 'start' });
  try {
    for (let part = 0; part < chunks.length; part++)
      await api('/api/restore', { action: 'upload', id, part, changes: chunks[part] });
    await api('/api/restore', { action: 'commit', id, parts: chunks.length });
  } catch (error) {
    // Failed uploads never alter the library. If cancellation cannot reach the
    // server, the staging area expires and is reclaimed on the next restore.
    await api('/api/restore', { action: 'cancel', id }).catch(() => {});
    throw error;
  }
}
export function atomic(changes) {
  if (!changes.length) return Promise.resolve();
  for (const change of changes) {
    if (!change.delete && jsonBytes(change.value) > LIMITS.record)
      return Promise.reject(
        new Error(t('Record exceeds 1 MiB. Split the bank or use smaller images/exams.'))
      );
  }
  if (usesServerStorage()) {
    if (changes.length > LIMITS.changes)
      return Promise.reject(new Error(t('Account transaction exceeds 20,000 records.')));
    return api('/api/records', { changes });
  }
  return new Promise((resolve, reject) => {
    const transaction = transactionFor([...new Set(changes.map((c) => c.store))], 'readwrite');
    writes++;
    for (const change of changes)
      transaction
        .objectStore(change.store)
        [change.delete ? 'delete' : 'put'](change.delete ? change.id : change.value);
    transaction.oncomplete = () => {
      writes--;
      resolve();
    };
    transaction.onabort = () => {
      writes--;
      reject(
        transaction.error ||
          new Error(t('Local transaction failed. No partial changes were saved.'))
      );
    };
    transaction.onerror = () => {};
  });
}
