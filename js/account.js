import { t } from './i18n.js';
import { el, button } from './dom.js';
import { LIMITS, jsonBytes } from './limits.js';

let session = { user: null, googleEnabled: false };
let accountWrites = 0;
let beforeAccountChange = async () => {};
export const setBeforeAccountChange = (action) => {
  beforeAccountChange = action;
};
let writeQueue = Promise.resolve();
export const signedIn = () => !!session.user;
export const localDatabase = () => session.storage === 'local';
export const usesServerStorage = () => signedIn() || localDatabase();
export async function api(path, body) {
  if (body && jsonBytes(body) > LIMITS.request)
    throw new Error(t('Transaction exceeds 2 MiB. Import a smaller backup.'));
  if (!body) return performRequest(path);
  accountWrites++;
  // Preserve the ordering guaranteed by IndexedDB in guest mode, especially for
  // exam autosaves followed by submission/deletion of the active snapshot.
  const job = writeQueue.catch(() => {}).then(() => performRequest(path, body));
  writeQueue = job;
  try {
    return await job;
  } finally {
    accountWrites--;
  }
}
async function performRequest(path, body) {
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(session.user ? { 'X-Quitsar-User': session.user.id } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ? t(result.error) : t('Account request failed.'));
    return result;
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        t(
          localDatabase()
            ? 'Local database unavailable. Start the local server and try again.'
            : 'Account storage needs a connection. Reconnect and try saving again.'
        )
      );
    throw error;
  }
}
globalThis.addEventListener?.('beforeunload', (event) => {
  if (accountWrites) {
    event.preventDefault();
    event.returnValue = t('Account changes are still saving.');
  }
});
export async function initializeAccount() {
  // Static hosting and offline guest mode remain supported. A remembered account must
  // never silently fall back to the guest database when its session cannot be checked.
  const mode = localStorage.getItem('quitsar-account');
  const unavailable = () =>
    new Error(
      t(
        mode === 'local'
          ? 'Local database unavailable. Start the local server and try again.'
          : 'Account service unavailable. Reconnect to open your account.'
      )
    );
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (
      response.status === 404 ||
      !response.headers.get('Content-Type')?.includes('application/json')
    ) {
      if (mode) throw unavailable();
    } else {
      if (!response.ok) throw unavailable();
      session = await response.json();
      if (mode && !usesServerStorage()) {
        if (mode === 'local') throw unavailable();
        throw new Error(
          t(
            'Your session expired. Use Sign in with Google to reopen your account, or Continue as guest.'
          )
        );
      }
    }
  } catch (error) {
    if (mode || !(error instanceof TypeError)) {
      showAccount();
      if (mode === 'local') throw unavailable();
      throw error;
    }
  }
  if (usesServerStorage()) localStorage.setItem('quitsar-account', localDatabase() ? 'local' : '1');
  showAccount();
}
export function showAccount() {
  const target = document.querySelector('#account');
  if (!target) return;
  const header = document.querySelector('#header-account');
  header?.replaceChildren(
    ...(!session.user &&
    !localDatabase() &&
    (session.googleEnabled || localStorage.getItem('quitsar-account') === '1')
      ? [
          el(
            'a',
            { href: '/api/auth/google', class: 'google-signin' },
            el('img', { src: 'assets/google/g-logo.png', alt: '', width: 20, height: 20 }),
            el('span', {}, t('Sign in with Google'))
          )
        ]
      : [])
  );
  if (localDatabase()) {
    target.replaceChildren(
      el('p', {}, t('Local database · single user')),
      el('small', {}, t('Saved on this server. No sign-in required.'))
    );
    return;
  }
  target.replaceChildren(
    el(
      'div',
      {},
      el('p', {}, session.user ? session.user.email : t('Guest · saved in this browser')),
      session.user
        ? button(
            t('Sign out'),
            async () => {
              if (
                !confirm(
                  t(
                    'Sign out? Finish your current action first. Saved account data stays in your account.'
                  )
                )
              )
                return;
              await beforeAccountChange();
              if (accountWrites)
                throw new Error(t('Please wait for your changes to finish saving.'));
              await api('/api/auth/logout', {});
              localStorage.removeItem('quitsar-account');
              location.reload();
            },
            'subtle'
          )
        : [
            localStorage.getItem('quitsar-account') &&
              button(
                t('Continue as guest'),
                () => {
                  localStorage.removeItem('quitsar-account');
                  location.reload();
                },
                'subtle'
              ),
            el(
              'small',
              {},
              session.googleEnabled
                ? t('Accounts save online. Guest data stays separate; transfer it with a backup.')
                : t('Google sign-in is available on the configured Cloudflare deployment.')
            )
          ]
    )
  );
}
