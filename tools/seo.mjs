import { createHash } from 'node:crypto';

// A deployment URL must be explicit: never canonicalize to a guessed Pages domain.
export function siteOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\./.test(url.hostname)
  ) {
    throw new Error('SITE_URL must be a public HTTPS origin without a path, query, or fragment.');
  }
  return url.origin;
}

export function seoFiles(html, { url, noindex = false } = {}) {
  const origin = siteOrigin(url);
  const indexable = Boolean(origin) && !noindex;
  const canonical = origin ? origin + '/' : null;
  const escape = (value) =>
    value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'quitsar',
    applicationCategory: 'EducationalApplication',
    operatingSystem: 'Any',
    browserRequirements: 'Requires JavaScript and a modern web browser.',
    description:
      'Study any subject with question banks, focused review, and timed practice exams. Guest study works offline.',
    inLanguage: ['en', 'sk', 'cs', 'de', 'es', 'fr'],
    ...(canonical ? { url: canonical } : {})
  };
  const json = JSON.stringify(schema).replaceAll('<', '\\u003c');
  const hash = createHash('sha256').update(json).digest('base64');
  const metadata = [
    ...(canonical
      ? [
          `<link rel="canonical" href="${escape(canonical)}" />`,
          `<meta property="og:url" content="${escape(canonical)}" />`
        ]
      : []),
    `<script type="application/ld+json">${json}</script>`
  ].join('\n    ');
  return {
    html: html
      .replace('<!-- deployment-seo -->', metadata)
      .replace(
        'name="robots" content="noindex, follow"',
        `name="robots" content="${indexable ? 'index' : 'noindex'}, follow"`
      )
      .replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
    // Allow page fetching so crawlers can see noindex on nonproduction builds.
    robots: `User-agent: *\nAllow: /\nDisallow: /api/\n${indexable ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`,
    sitemap: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable ? `\n  <url><loc>${escape(canonical)}</loc></url>\n` : ''}</urlset>\n`,
    indexable
  };
}
