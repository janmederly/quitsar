import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { seoFiles, siteOrigin } from '../tools/seo.mjs';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('production SEO uses one consistent origin and CSP permits exactly the generated JSON-LD', () => {
  const { html, robots, sitemap, indexable } = seoFiles(source, {
    url: 'https://study.example.org/'
  });
  assert.ok(indexable);
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.match(html, /rel="canonical" href="https:\/\/study.example.org\/"/);
  assert.match(html, /name="robots" content="index, follow"/);
  const json = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1];
  const schema = JSON.parse(json);
  assert.equal(schema['@type'], 'WebApplication');
  assert.equal(schema.url, 'https://study.example.org/');
  assert.match(
    html,
    new RegExp(
      createHash('sha256')
        .update(json)
        .digest('base64')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
  );
  assert.ok(!html.includes('unsafe-inline'));
  assert.match(robots, /Allow: \/\nDisallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/study.example.org\/sitemap.xml/);
  assert.equal((sitemap.match(/<loc>/g) || []).length, 1);
  assert.ok(!sitemap.includes('#'));
});

test('unconfigured and preview builds expose noindex without advertising sitemap URLs', () => {
  for (const options of [{}, { url: 'https://study.example.org', noindex: true }]) {
    const result = seoFiles(source, options);
    assert.equal(result.indexable, false);
    assert.match(result.html, /name="robots" content="noindex, follow"/);
    assert.ok(!result.robots.includes('Sitemap:'));
    assert.ok(!result.sitemap.includes('<loc>'));
    assert.ok(!result.robots.includes('Disallow: /\n'));
  }
  assert.ok(!seoFiles(source).html.includes('rel="canonical"'));
});

test('invalid deployment URLs are rejected instead of generating wrong canonicals', () => {
  for (const url of [
    'not a URL',
    'http://example.org',
    'https://localhost',
    'https://127.0.0.1',
    'https://example.org/app',
    'https://user:password@example.org',
    'https://example.org/?x=1',
    'https://example.org/#home'
  ]) {
    assert.throws(() => siteOrigin(url), undefined, url);
  }
});

test('the initial document has readable public content and descriptive metadata without JavaScript', () => {
  assert.equal((source.match(/<h1>/g) || []).length, 1);
  assert.match(source, /<meta\s+name="description"\s+content="[^"]+"/);
  assert.match(source, /<h2>Your next question/);
  assert.match(source, /practice recall/);
  assert.match(source, /<noscript\b/);
  assert.match(source, /width="41" height="44"/);
});
