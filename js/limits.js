export const LIMITS = Object.freeze({
  bank: 512 * 1024,
  image: 256 * 1024,
  record: 1024 * 1024,
  request: 2 * 1024 * 1024,
  account: 20 * 1024 * 1024,
  backup: 24 * 1024 * 1024,
  changes: 20000
});
export const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
