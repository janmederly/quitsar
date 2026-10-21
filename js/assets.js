import { t } from './i18n.js';
import { safePath } from './validation.js';
import { LIMITS } from './limits.js';
const urls = new Map();
const svgTags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc'
]);
const svgAttrs = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'transform',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline'
]);
export function sanitizeSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg')
    throw new Error(t('Invalid SVG'));
  function copy(source) {
    if (!svgTags.has(source.localName)) return null;
    const target = document.createElementNS('http://www.w3.org/2000/svg', source.localName);
    for (const attr of source.attributes)
      if (
        svgAttrs.has(attr.name) &&
        !/url\s*\(|javascript:|https?:|data:|\/\//i.test(attr.value) &&
        attr.value.length < 200000
      )
        target.setAttribute(attr.name, attr.value);
    for (const child of source.childNodes) {
      if (child.nodeType === 3) target.append(document.createTextNode(child.textContent));
      else if (child.nodeType === 1) {
        const clean = copy(child);
        if (clean) target.append(clean);
      }
    }
    return target;
  }
  return new XMLSerializer().serializeToString(copy(doc.documentElement));
}
export async function readAsset(file, path) {
  if (!safePath(path) || file.size > LIMITS.image)
    throw new Error(t`Invalid image path or image exceeds 256 KiB: ${path}`);
  if (/\.svg$/i.test(path)) return { mime: 'image/svg+xml', data: sanitizeSvg(await file.text()) };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = String.fromCharCode(...bytes.slice(0, 3)) === 'GIF';
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  const mime =
    /\.png$/i.test(path) && png
      ? 'image/png'
      : /\.jpe?g$/i.test(path) && jpeg
        ? 'image/jpeg'
        : /\.gif$/i.test(path) && gif
          ? 'image/gif'
          : /\.webp$/i.test(path) && webp
            ? 'image/webp'
            : null;
  if (!mime) throw new Error(t`Image signature does not match its extension: ${path}`);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { mime, data: btoa(binary) };
}
export function assetUrl(bank, path) {
  const asset = bank?.assets?.[path];
  if (!asset) return null;
  const key = `${bank.id}:${bank.importedAt}:${path}`;
  if (!urls.has(key)) {
    const body =
      asset.mime === 'image/svg+xml'
        ? asset.data
        : Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0));
    urls.set(key, URL.createObjectURL(new Blob([body], { type: asset.mime })));
  }
  return urls.get(key);
}
export function releaseAssets() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}
