import { t, getLocale } from './i18n.js';
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'class') node.className = value;
    else if (
      name === 'checked' ||
      name === 'disabled' ||
      name === 'selected' ||
      name === 'multiple'
    )
      node[name] = !!value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== undefined && child !== null && child !== false)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export const button = (label, action, className = '', attrs = {}) =>
  el('button', { type: 'button', class: className, onclick: action, ...attrs }, label);
export const badge = (label, className = '') => el('span', { class: `badge ${className}` }, label);
const iconPaths = {
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  banks: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
  study: 'm12 3 9 9-9 9-9-9Z M9 12l2 2 4-4',
  exam: 'M12 8v5l3 2 M9 2h6 M12 2v3 M19 5l2 2 M21 13a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  review: 'M5 21V3 M5 4c5-4 9 4 14 0v10c-5 4-9-4-14 0',
  results: 'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4',
  tools: 'M7 3v17 M3 16l4 4 4-4 M17 21V4 M13 8l4-4 4 4',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
};
export function icon(name, className = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '20',
    height: '20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `icon ${className}`
  }))
    node.setAttribute(key, value);
  const path = document.createElementNS(node.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name] || iconPaths.study);
  node.append(path);
  return node;
}
let fieldSequence = 0;
export function field(label, control, hint) {
  control.setAttribute('aria-label', label);
  const hintId = `field-hint-${++fieldSequence}`;
  if (hint) control.setAttribute('aria-describedby', hintId);
  return el(
    'label',
    { class: 'field' },
    el('span', {}, label),
    control,
    hint && el('small', { id: hintId }, hint)
  );
}
export const date = (time) => (time ? new Date(time).toLocaleString(getLocale()) : t('Never'));
export const number = (value, digits = 2) =>
  Number(value).toLocaleString(getLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
export const percent = (points, count) =>
  count
    ? `${((100 * points) / count).toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
    : '—';
export const prettyType = (value) =>
  ({
    open_ended: t('Open ended'),
    single_choice: t('Single choice'),
    multiple_choice: t('Multiple choice'),
    image_recognition: t('Image recognition')
  })[value] || value;
export function announce(message) {
  document.querySelector('#announcer').textContent = '';
  setTimeout(() => {
    document.querySelector('#announcer').textContent = message;
  }, 30);
}
export function modal(title, ...content) {
  const dialog = document.querySelector('#modal');
  document
    .querySelector('#modal-body')
    .replaceChildren(el('h2', { id: 'modal-title' }, title), ...content);
  if (!dialog.open) dialog.showModal();
  return dialog;
}
export function download(name, value, type = 'application/json') {
  const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
    type
  });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function table(headers, rows) {
  return el(
    'div',
    { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': headers.join(', ') },
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          headers.map((h) => el('th', { scope: 'col' }, h))
        )
      ),
      el(
        'tbody',
        {},
        rows.map((row) =>
          el(
            'tr',
            {},
            row.map((cell) => el('td', {}, cell))
          )
        )
      )
    )
  );
}
