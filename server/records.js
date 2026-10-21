import { LIMITS, jsonBytes } from '../js/limits.js';
import { isRecord } from '../js/validation.js';

import { validateRecord } from '../js/records.js';

export const stores = new Set(['banks', 'states', 'attempts', 'history', 'settings', 'active']);
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

export async function readBody(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))
    fail(415, 'Expected application/json.');
  if (Number(request.headers.get('Content-Length')) > LIMITS.request)
    fail(413, 'Request exceeds 2 MiB.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Missing JSON body.');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > LIMITS.request) {
      await reader.cancel();
      fail(413, 'Request exceeds 2 MiB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, 'Malformed JSON.');
  }
}
export function validateChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > LIMITS.changes)
    fail(400, 'Use 1–20,000 changes per transaction.');
  const seen = new Set();
  for (const change of changes) {
    if (!isRecord(change) || !stores.has(change.store)) fail(400, 'Invalid store.');
    if (change.delete !== undefined && typeof change.delete !== 'boolean')
      fail(400, 'Invalid deletion flag.');
    const id = change.delete ? change.id : change.value?.id;
    if (typeof id !== 'string' || !id.length || id.length > 400) fail(400, 'Invalid record ID.');
    const key = JSON.stringify([change.store, id]);
    if (seen.has(key)) fail(400, 'Duplicate record in transaction.');
    seen.add(key);
    if (change.delete) continue;
    if (!isRecord(change.value) || jsonBytes(change.value) > LIMITS.record)
      fail(413, 'Record exceeds 1 MiB. Split the bank or use smaller images/exams.');
    try {
      validateRecord(change.store, change.value);
    } catch (error) {
      fail(error.status || 400, error.message);
    }
  }
  return changes;
}
