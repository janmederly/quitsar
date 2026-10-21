import { LIMITS, jsonBytes } from '../../js/limits.js';
import { stores, readBody, validateChanges } from '../../server/records.js';
import { restore } from '../../server/restore.js';
import { oauthAdmission, oauthCounters, OAUTH_WINDOW } from '../../server/oauth-limit.js';
export { readBody, validateChanges } from '../../server/records.js';
import { admitWrite, maintain, API_WINDOW } from '../../server/maintenance.js';
const encoder = new TextEncoder();
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
export async function hash(value) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
}
const cookieName = (request, kind) =>
  `${new URL(request.url).protocol === 'https:' ? '__Host-' : ''}qr_${kind}`;
function cookie(request, kind, value, age) {
  return `${cookieName(request, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function readCookie(request, kind) {
  return (
    (request.headers.get('Cookie') || '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName(request, kind) + '='))
      ?.split('=')[1] || ''
  );
}
function configured(env) {
  return !!(env.DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.APP_ORIGIN);
}
async function userFor(request, env) {
  const token = readCookie(request, 'session');
  if (!token || !env.DB) return null;
  return env.DB.prepare(
    'SELECT users.id, users.email, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?'
  )
    .bind(await hash(token), Date.now())
    .first();
}
async function auth(request, env, path) {
  const url = new URL(request.url);
  if (path === '/api/auth/session' && request.method === 'GET') {
    const user = await userFor(request, env);
    if (user) await maintain(env.DB);
    return json({
      user,
      googleEnabled: configured(env),
      limits: LIMITS
    });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const user = await userFor(request, env);
    const expectedUser = request.headers.get('X-Quitsar-User');
    if (user && expectedUser && expectedUser !== user.id)
      fail(409, 'Account changed in another tab. Reload before continuing.');
    if (env.DB)
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
        .bind(await hash(readCookie(request, 'session')))
        .run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, 'session', '', 0) });
  }
  if (!configured(env)) fail(503, 'Google sign-in is not configured.');
  if (url.origin !== new URL(env.APP_ORIGIN).origin)
    fail(400, 'Sign in using the configured application URL.');
  const redirectUri = `${url.origin}/api/auth/callback`;
  if (path === '/api/auth/google' && request.method === 'GET') {
    const now = Date.now();
    // Cloudflare supplies this header. Never use client-controlled forwarding
    // headers; local development without it shares one conservative bucket.
    const client = await hash(request.headers.get('CF-Connecting-IP') || 'local');
    if (!oauthAdmission(env.DB, client, now))
      fail(429, 'Too many sign-in attempts. Please try again later.');
    const state = random();
    const verifier = random();
    const challenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
      )
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    await env.DB.batch([
      ...oauthCounters(env.DB, client, now),
      env.DB.prepare(
        'DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at<? LIMIT 128)'
      ).bind(now),
      env.DB.prepare(
        'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<? LIMIT 128)'
      ).bind(now),
      env.DB.prepare('INSERT INTO oauth_states VALUES (?,?,?)').bind(
        await hash(state),
        verifier,
        now + OAUTH_WINDOW
      )
    ]);
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: google.href,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Set-Cookie': cookie(request, 'oauth', state, 600)
      }
    });
  }
  if (path === '/api/auth/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state');
    if (!state || state !== readCookie(request, 'oauth'))
      fail(400, 'Sign-in state mismatch. Please try again.');
    const pending = await env.DB.prepare(
      'DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING verifier'
    )
      .bind(await hash(state), Date.now())
      .first();
    if (!pending || !url.searchParams.get('code'))
      fail(400, 'Sign-in expired or cancelled. Please try again.');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'),
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier
      })
    });
    if (!response.ok) fail(401, 'Google sign-in failed. Please try again.');
    const tokens = await response.json();
    // Fetch identity directly from Google with the server-exchanged token; never trust client profile data.
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!profileResponse.ok) fail(401, 'Could not verify Google account.');
    const profile = await profileResponse.json();
    if (!profile.sub || !profile.email || profile.email_verified !== true)
      fail(401, 'A verified Google email is required.');
    const token = random();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name'
      ).bind(profile.sub, profile.email, profile.name || profile.email, Date.now()),
      env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(
        await hash(readCookie(request, 'session'))
      ),
      env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(
        await hash(token),
        profile.sub,
        Date.now() + 604800000
      )
    ]);
    const headers = new Headers({
      Location: '/#home',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    headers.append('Set-Cookie', cookie(request, 'session', token, 604800));
    headers.append('Set-Cookie', cookie(request, 'oauth', '', 0));
    return new Response(null, { status: 302, headers });
  }
  fail(404, 'Unknown authentication route.');
}
export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'Method not allowed.');
    if (request.method === 'POST' && request.headers.get('Origin') !== url.origin)
      fail(403, 'Cross-origin writes are forbidden.');
    if (url.pathname.startsWith('/api/auth/')) return await auth(request, env, url.pathname);
    if (!env.DB) fail(503, 'Database is not configured.');
    const user = await userFor(request, env);
    if (!user)
      fail(401, 'Your session expired. Sign in again; unsaved changes have not been stored.');
    if (request.headers.get('X-Quitsar-User') !== user.id)
      fail(409, 'Account changed in another tab. Reload before continuing.');
    if (request.method === 'POST') await admitWrite(env.DB, user.id);
    await maintain(env.DB);
    if (url.pathname === '/api/restore' && request.method === 'POST')
      return json(await restore(request, env.DB, user.id));
    if (url.pathname === '/api/records' && request.method === 'GET') {
      const store = url.searchParams.get('store');
      if (!stores.has(store)) fail(400, 'Invalid store.');
      const id = url.searchParams.get('id');
      if (id !== null) {
        const row = await env.DB.prepare(
          'SELECT value FROM records WHERE user_id=? AND store=? AND id=?'
        )
          .bind(user.id, store, id)
          .first();
        return json(row ? JSON.parse(row.value) : null);
      }
      const rows = await env.DB.prepare(
        'SELECT value FROM records WHERE user_id=? AND store=? ORDER BY id'
      )
        .bind(user.id, store)
        .all();
      return json(rows.results.map((row) => JSON.parse(row.value)));
    }
    if (url.pathname === '/api/records' && request.method === 'POST') {
      const body = await readBody(request);
      if (stores.has(body?.clear) || Array.isArray(body?.clearStores)) {
        const names = body.clearStores || [body.clear];
        if (!names.length || names.length > stores.size || names.some((name) => !stores.has(name)))
          fail(400, 'Invalid stores to clear.');
        await env.DB.batch(
          names.map((name) =>
            env.DB.prepare('DELETE FROM records WHERE user_id=? AND store=?').bind(user.id, name)
          )
        );
      } else {
        const changes = validateChanges(body?.changes);
        // JSON table expansion keeps large exams/backups below D1's per-invocation
        // query limit. Split bindings below D1's 2,000,000-byte string limit.
        const chunks = [];
        let chunk = [];
        let bytes = 2;
        for (const change of changes) {
          const size = jsonBytes(change) + 1;
          if (chunk.length && bytes + size > 1500000) {
            chunks.push(JSON.stringify(chunk));
            chunk = [];
            bytes = 2;
          }
          chunk.push(change);
          bytes += size;
        }
        if (chunk.length) chunks.push(JSON.stringify(chunk));
        const deletes = chunks.map((data) =>
          env.DB.prepare(
            `DELETE FROM records WHERE user_id=? AND (store,id) IN
          (SELECT json_extract(value,'$.store'),json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.delete'))`
          ).bind(user.id, data)
        );
        const upserts = chunks.map((data) =>
          env.DB.prepare(
            `INSERT INTO records (user_id,store,id,value,bytes)
          SELECT ?,json_extract(value,'$.store'),json_extract(value,'$.value.id'),json_extract(value,'$.value'),length(CAST(json_extract(value,'$.value') AS BLOB))
          FROM json_each(?) WHERE NOT COALESCE(json_extract(value,'$.delete'),0)
          ON CONFLICT(user_id,store,id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes`
          ).bind(user.id, data)
        );
        await env.DB.batch([...deletes, ...upserts]);
      }
      return json({ ok: true });
    }
    fail(404, 'Unknown API route.');
  } catch (error) {
    if (/api_rate/.test(error.message))
      return json({ error: 'Too many writes. Please wait a minute and retry.' }, 429, {
        'Retry-After': String(
          Math.max(1, Math.ceil((API_WINDOW - (Date.now() % API_WINDOW)) / 1000))
        )
      });
    if (error.status === 429 || /oauth_rate/.test(error.message))
      return json({ error: 'Too many sign-in attempts. Please try again later.' }, 429, {
        'Retry-After': String(
          Math.max(1, Math.ceil((OAUTH_WINDOW - (Date.now() % OAUTH_WINDOW)) / 1000))
        )
      });
    if (/account_quota/.test(error.message))
      return json(
        {
          error:
            'Account limit reached (20 MiB or 20,000 records). Export a backup and remove unused data.'
        },
        413
      );
    if (!error.status) console.error('API request failed', error.message);
    return json(
      {
        error: error.status
          ? error.message
          : 'The server could not complete this request. Please try again.'
      },
      error.status || 500
    );
  }
}
