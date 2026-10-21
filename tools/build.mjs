import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { seoFiles } from './seo.mjs';
const seo = seoFiles(await readFile(new URL('../index.html', import.meta.url), 'utf8'), {
  url: process.env.SITE_URL,
  noindex:
    process.env.SEO_NOINDEX === '1' ||
    (process.env.CF_PAGES === '1' &&
      Boolean(process.env.CF_PAGES_BRANCH) &&
      process.env.CF_PAGES_BRANCH !== (process.env.SEO_PRODUCTION_BRANCH || 'main'))
});
// Explicit allowlist: never publish credentials, tests, SQL, dependencies or tooling.
const output = new URL('../dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of ['index.html', 'sw.js', 'styles', 'js', 'assets', 'banks']) {
  await cp(new URL('../' + path, import.meta.url), new URL(path, output), { recursive: true });
}
await writeFile(new URL('index.html', output), seo.html);
await writeFile(new URL('robots.txt', output), seo.robots);
await writeFile(new URL('sitemap.xml', output), seo.sitemap);
await writeFile(
  new URL('_routes.json', output),
  JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] })
);
await writeFile(
  new URL('_headers', output),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Content-Security-Policy: frame-ancestors 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/sw.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/404.html
  X-Robots-Tag: noindex
/banks/*
  X-Robots-Tag: noindex
`
);
// Disable Pages' automatic SPA fallback for missing assets and secret paths.
await writeFile(
  new URL('404.html', output),
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found · quitsar</title><h1>Not found</h1><a href="/">Open quitsar</a></html>'
);
console.log('Cloudflare Pages assets built in dist/');
if (!seo.indexable)
  console.log(
    'Search indexing disabled. Set SITE_URL to your production HTTPS origin and check preview settings to enable it.'
  );
