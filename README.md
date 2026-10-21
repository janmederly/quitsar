# Quitsar

:warning: This is an vibe-coded experiment. Use with caution, the webapp was tested, code was briefly checked, but I did not do any deep code review for this.

A study and practice-exam app built with HTML, CSS, and native JavaScript modules. Import question banks, review with spaced repetition, and take configurable practice exams with detailed results.

Choose browser storage for offline guest study, a local SQLite database for a single-user installation, or Google accounts backed by Cloudflare Pages Functions and D1. The local database mode requires no authentication and saves the shared library on the machine running the app.

## Features

- Open-ended, single-choice, multiple-choice, and image-recognition questions.
- Filters for banks, topics, subtopics, tags, difficulty, and question type.
- Topic and new-question study, configurable session sizes, and new-first, random, or difficulty-based practice.
- A dedicated Review screen with spaced repetition, incorrect answers, flagged questions, and skipped questions.
- Timed or untimed exams with answer autosave, interrupted-session recovery, and strict or partial scoring.
- Explanations, option rationales, grouped results, print views, and JSON/CSV exports.
- Validated bank imports and backup merges, including imported images.
- Import questions directly from Overview; the import form includes a field-by-field format guide, JSON Schema, downloadable example, and a copyable prompt for your AI tool.
- English, Slovak, Czech, German, Spanish, and French interfaces, with system/light/dark themes and keyboard navigation.

## Local development

Use **Node.js 22.13 or newer**; the preferred version is recorded in `.node-version`.

For guest mode, start the dependency-free local server:

```sh
npm start
```

Open **http://127.0.0.1:8080** to start with the included high-school biology bank. It loads automatically when your library is empty, with 12 questions on cells, genetics, and ecosystems. Importing your own bank replaces this automatic demo; an explicitly loaded demo can stay alongside your material. **Exam simulator** includes a quick quiz, a timed practice exam, and written-answer practice, each with a preview before starting. You can also load the demo explicitly from **Question banks → Try the demo bank**. Use HTTP rather than opening `index.html` directly: modules, browser storage, and service workers require a suitable origin.

Wait for **Offline cache ready** before stopping the server. Later visits can work offline at the same hostname and port in browsers that support service workers. Guest data belongs to that browser profile and origin; switching between `localhost` and `127.0.0.1`, or changing ports, opens a separate store.

Install development dependencies to use the build tools, browser tests, or local account API:

```sh
npm ci
```

### Single-user local database

To keep the library on the host instead of in each browser, start the optional SQLite backend:

```sh
npm run start:local
```

Open **http://127.0.0.1:8080**. The app detects local database mode automatically. There is one library for the installation, with no login, password, or Google configuration. All banks, imported images, progress, history, settings, completed exams, and the active exam are stored in **`.data/quitsar.sqlite`**. The file and its SQLite journal files are ignored by Git and cannot be downloaded through the static server.

The backend uses Node's built-in [`node:sqlite`](https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html), so it needs no additional database package or separate database service. Configuration is optional:

| Option            | Default                                            | Purpose                                                                                     |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `STORAGE_MODE`    | `browser`                                          | Set to `local` to enable SQLite; `start:local` selects it unless this variable overrides it |
| `LOCAL_DB_PATH`   | `.data/quitsar.sqlite` under the project root | SQLite file path; relative overrides resolve from the working directory                     |
| `HOST`            | `127.0.0.1`                                        | HTTP bind address                                                                           |
| `ALLOWED_ORIGINS` | empty                                              | Comma-separated additional HTTP origins permitted to access the local API                   |
| `PORT`            | `8080`                                             | HTTP port                                                                                   |

For example:

```sh
STORAGE_MODE=local LOCAL_DB_PATH=/path/to/library.sqlite PORT=8081 npm start
```

Keep the server running while studying: database reads and writes require a connection to it, even when the app shell is cached. Browser profiles accessing the same installation share the same library. Anyone who can reach this server has access to that library; the default loopback bind keeps access on the host machine. There is no per-user separation or simultaneous-edit conflict resolution. The API accepts loopback hostnames and the explicit bind address even when bound to every interface in Docker. For a LAN hostname, set an explicit origin such as `ALLOWED_ORIGINS=http://study.internal:8080`; arbitrary Host headers are rejected independently of `HOST`.

Existing browser or Google-account data is not migrated automatically. Export a full backup from the original mode, start local database mode, and restore it through **Backup & export**. To copy the database file directly, stop the server first so committed SQLite journal data is checkpointed; the app's full backup export is also supported.

### Local account API

Account development uses Wrangler to run Pages Functions and a local D1 database.

```sh
cp .dev.vars.example .dev.vars
npm run db:local
npm run pages:dev
```

Open **http://localhost:8788**. For Google sign-in, fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars`, keep `APP_ORIGIN=http://localhost:8788`, and register `http://localhost:8788/api/auth/callback` as the OAuth client's redirect URI. Without Google credentials, guest mode remains available.

The `DB` binding and migration directory are defined in `wrangler.toml`. Wrangler keeps local database state in `.wrangler/`. Both `.dev.vars` and `.wrangler/` are ignored by Git; `.dev.vars.example` contains placeholders for contributors.

### Docker

The Docker image defaults to the browser-storage server:

```sh
docker build -t quitsar .
docker run --rm --name quitsar --read-only --cap-drop=ALL --security-opt=no-new-privileges -p 127.0.0.1:8080:8080 quitsar
```

Open **http://127.0.0.1:8080**. Imported banks, images, progress, and results stay in the browser's IndexedDB, so no container volume is needed. The image uses Node 22 Alpine and runs as the unprivileged `node` user.

To use the single-user SQLite backend with persistent container storage:

```sh
docker volume create quitsar-data
docker run --rm --name quitsar --read-only --cap-drop=ALL --security-opt=no-new-privileges -p 127.0.0.1:8080:8080 -e STORAGE_MODE=local -v quitsar-data:/data quitsar
```

In this mode the database is `/data/quitsar.sqlite`. The named volume retains it when the container is recreated. Keep that volume to preserve the library; it is the writable location needed by SQLite even with a read-only container filesystem.

## Architecture

The frontend uses native ES modules and direct DOM rendering, with no UI framework. The FSRS scheduler is vendored locally in `js/vendor/` with its MIT license; it requires no CDN or extra build step. `index.html` defines the shell, `js/app.js` initializes the account and storage layers and handles hash-based navigation, and screen modules implement study, exams, results, and library management.

```text
Browser UI
    │
    ├── Validation, image handling, scoring, scheduling, and backup logic
    │
    └── Storage interface (js/storage.js)
            ├── Guest: IndexedDB
            ├── Local: js/account.js → /api/* → Node server → SQLite file
            └── Account: js/account.js → /api/* → Pages Functions → D1

Service worker: caches the app shell and bundled demo; bypasses /api/*
```

| Area                                               | Responsibility                                                 |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `js/app.js`                                        | Startup, shared application context, navigation, and dashboard |
| `js/study.js`, `js/exam.js`, `js/results.js`       | Study sessions, exam lifecycle, and result views               |
| `js/management.js`                                 | Bank management, settings, and backup interface                |
| `js/question.js`, `js/filters.js`, `js/dom.js`     | Question rendering, pool selection, and shared UI helpers      |
| `js/storage.js`                                    | Shared persistence operations and atomic writes                |
| `js/account.js`                                    | Account session state, API access, and ordered account writes  |
| `js/validation.js`, `js/assets.js`, `js/limits.js` | Bank validation, imported-image handling, and size limits      |
| `js/scoring.js`, `js/spaced-repetition.js`         | Pure scoring and scheduling policies                           |
| `js/transfer.js`                                   | Backup validation, merge policy, and export serialization      |
| `js/i18n.js`, `js/locales/`                        | Language selection and bundled translations                    |
| `functions/api/[[path]].js`                        | Google OAuth, sessions, authorized record access, and quotas   |
| `migrations/`                                      | D1 SQL schema and migrations                                   |
| `sw.js`                                            | Versioned offline app-shell cache                              |
| `server/records.js`                                | Shared API request and bank/record validation                  |
| `tools/local-db.mjs`                               | Single-user SQLite schema, record API, and transactions        |
| `tools/`                                           | Local static server and static build/metadata generation       |

### Client and backend responsibilities

**Guest mode calls the browser database directly. Local database mode and signed-in mode call a backend.** The local Node backend accesses a SQLite file; the Cloudflare backend accesses D1. The frontend never opens the host database file, connects directly to D1, or receives database credentials.

```text
Guest mode — runs inside the browser:
Screen → js/storage.js → IndexedDB

Local database mode:
Browser: Screen → js/storage.js → js/account.js
                                    │
                              same-origin HTTP
                                    │
Host: tools/serve.mjs → tools/local-db.mjs → SQLite file

Signed-in mode:
Browser: Screen → js/storage.js → js/account.js
                                    │
                              same-origin HTTP
                                    │
Cloudflare: functions/api/[[path]].js → env.DB → D1
```

The browser handles rendering, question filtering, scoring, scheduling, image sanitization, and backup preparation. The backend handles Google sign-in, session verification, user isolation, request/record validation, quotas, and SQL reads and writes. Scoring and scheduling run in the client; the account API persists their results. This is a personal study app, not a server-authoritative examination system.

`tools/serve.mjs` and the Docker container serve static files for guest mode. With local database mode enabled, the same server also exposes the single-user record API. It uses a local-mode session response to select server storage without creating a signed-in user. The Google sign-in flow remains specific to the Cloudflare backend. Local account development runs the backend through Wrangler, with a local D1 database under `.wrangler/`; the hosted backend uses the configured Cloudflare D1 database.

### Shared storage interface and callers

Screens use `js/storage.js` through `get(store, id)`, `all(store)`, `put(store, record)`, `remove(store, id)`, and `atomic(changes)`. Each operation calls `usesServerStorage()`, which is true for local database mode or a signed-in account. It then selects IndexedDB or the HTTP API. Screen code uses the same persistence interface in all three modes.

| Trigger                                  | Caller                                                           | Records accessed                                               |
| ---------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Startup and screen refresh               | `js/app.js`, via `ctx.refresh()`                                 | Banks, states, history, attempts, preferences, and active exam |
| Import, update, enable, or delete a bank | `js/management.js`                                               | `banks`                                                        |
| Study response or question flag          | Shared methods in `js/app.js`, called by screen modules          | `states` and, for responses, `history`                         |
| Start or answer an exam                  | `js/exam.js`                                                     | `active`                                                       |
| Submit an exam                           | `js/exam.js`                                                     | `attempts`, `states`, `history`, and deletion of `active`      |
| Open a saved result                      | `js/app.js`, rendered by `js/results.js`                         | `attempts`                                                     |
| Save preferences                         | `js/management.js` or the header language handler in `js/app.js` | `settings`                                                     |
| Export or restore a backup               | `js/transfer.js` and `js/management.js`                          | The collections included in the backup                         |

On startup, `initializeAccount()` checks `/api/auth/session` before `openStorage()` decides whether to open IndexedDB. A local backend responds with `storage: "local"` and no authenticated user, causing the frontend to use the API and hide sign-in/sign-out controls. `ctx.refresh()` loads persisted records into the in-memory application context used by the screens. That context is temporary and rebuilt from storage after reload. Refresh currently loads whole collections; there is no paginated query layer or live subscription to another device's changes.

### What is stored where

All three modes expose six logical collections. In guest mode these are object stores in the browser's `quitsar` IndexedDB database, with records keyed by `id`. In local and account modes they are categories within a SQL `records` table.

| Collection | Stored content                                                                                        | Record identity                                             |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `banks`    | Metadata, questions, options, explanations, enabled status, and imported images                       | Bank ID                                                     |
| `states`   | Current question progress: FSRS memory state, interval, due date, counters, flags, and skipped status | Bank ID + question ID                                       |
| `history`  | Response events with question identity, Repeat/Know/skip, timestamp, and study/exam origin            | Event ID                                                    |
| `attempts` | Completed exam snapshots, answers, configuration, and timing                                          | Attempt ID                                                  |
| `settings` | Language, theme, scheduling, and other preferences                                                    | `preferences`; guest mode also has a `storage-check` record |
| `active`   | The unfinished exam, answers, navigation state, and absolute deadline                                 | `current`                                                   |

`states` holds the current learning state; `history` records individual response events. Question state deliberately excludes the bank version from its identity so compatible bank updates retain progress. Records also retain version information.

Questions and options are embedded inside the bank record rather than stored as separate database rows. Imported images are embedded there too: sanitized text for SVG and base64 data for raster images. Display uses temporary blob URLs. The source files under `banks/` are bundled content; importing them creates separate database records without modifying the repository files.

Exam attempts contain question snapshots so their text and options survive bank edits. Images remain associated with their bank and can become unavailable if the bank is removed or its assets change.

### Account database schema

The SQL schema is defined in [migrations/0001_accounts.sql](migrations/0001_accounts.sql). The account tables are:

| Table          | Purpose                                                             |
| -------------- | ------------------------------------------------------------------- |
| `users`        | Google user ID, email, display name, and creation timestamp         |
| `sessions`     | Hashed session token, user ID, and expiry timestamp                 |
| `oauth_states` | Short-lived sign-in state hash, PKCE verifier, and expiry timestamp |
| `records`      | Application records for all six collections                         |

Migrations `0002_restore.sql` through `0005_api_maintenance.sql` add private restore staging, OAuth rate counters, constant-time account quota counters, and write-rate/cleanup tables. Apply all migrations (`npm run db:remote`) before deploying an updated Pages Function to an existing installation. Migration `0004` backfills account usage from existing records; subsequent inserts, updates, and deletes maintain the counters inside their transaction. Local SQLite installs apply their applicable migrations automatically on startup.

The application data table has this shape:

```text
records
├── user_id   User who owns the record
├── store     banks / states / history / attempts / settings / active
├── id        Record ID within that collection
├── value     Complete record serialized as JSON text
└── bytes     Serialized size used for storage quotas

Primary key: (user_id, store, id)
```

This is a relational account/session schema with JSON application records. It keeps the guest and account data models similar, but question-level filtering and result aggregation happen in JavaScript rather than SQL joins. SQL constraints enforce valid collection names, JSON, and record sizes; triggers enforce per-account storage quotas.

### Local SQLite schema

`tools/local-db.mjs` initializes the database automatically on first use. It has one `records` table with `store`, `id`, `value` (JSON text), and `bytes` columns. Its primary key is `(store, id)`: every browser uses the same library, so there are no user, session, or OAuth tables.

SQLite runs in WAL mode with full synchronization and a busy timeout. Changes to multiple collections use a single SQL transaction. Local requests reuse the Cloudflare API's bank/record validation and per-record/request limits, including 1 MiB per record, 2 MiB per request, and 20,000 changes per transaction. The Cloudflare-specific aggregate quota of 20 MiB / 20,000 stored records does not apply to the local file. Backup restore uses private staging tables and smaller upload requests, followed by one atomic commit; it accepts up to 24 MiB / 150,000 records in both server modes.

### Read and write flows

For an account read, `storage.js` calls `account.js`, which sends `GET /api/records?store=banks` or adds `&id=...` for a single record. The Pages Function verifies the session cookie, checks the expected user header, and executes a parameterized query scoped to the authenticated user's ID. It parses stored JSON and returns it to the browser.

Writes use `POST /api/records` with a list of changes. For example, `db.put('settings', preferences)` becomes a single change for the `settings` collection. The backend validates every record using the same schemas as backup imports and commits the changes through a D1 batch. Invalid legacy records are excluded from application views, with controls to download and explicitly remove each affected record. Account writes are queued in `account.js` so autosaves and later submission writes preserve their order within the page. Server-backed exam autosaves wait for a 750 ms typing pause and retain at most one in-flight write and the latest pending state. Navigation, submission, sign-out, and language changes flush that pending state. Guest saves still start directly in the input handler. Unsaved server answers trigger the browser’s leave-page warning.

The local API uses the same GET/POST record format, with no authentication cookie or user header required. It checks write origins and rejects cross-site browser access. Requests are handled on the host through `tools/local-db.mjs`, using prepared SQLite statements.

Two common operations span multiple collections:

- **Study response:** the client calculates the next schedule, then `db.atomic()` saves the updated `states` record and a new `history` event together.
- **Exam submission:** the client prepares the completed attempt and progress/history changes, then saves them and removes `active/current` together. A failed commit retains the saved active exam for recovery.

In guest mode, `atomic()` uses one IndexedDB transaction across the affected stores. In account mode, it sends the changes in one API request for a D1 batch. Local mode sends the same request and commits it with a SQLite transaction; no asynchronous work runs inside that transaction. These operations commit together or roll back together. There is no cross-device conflict resolution or coordinated multi-tab editing; simultaneous edits to a record use the last successful write.

### Authentication, browser storage, and offline boundaries

Authentication uses a server-side Google authorization-code exchange with PKCE, browser-bound OAuth state, and hashed session tokens in D1. The browser receives an HttpOnly session cookie; SQL operations use the server-verified user identity. Write requests must come from the same origin. Google access tokens are used for identity lookup and are not stored. Sign-in initiation is limited to 10 requests per client IP and 300 requests globally per fixed 10-minute window, enforced transactionally in D1. A bounded in-memory gate rejects repeated requests before database access; no more than 1,000 pending OAuth states are allowed. Rejections return HTTP 429 and Retry-After. Client IPs are taken only from Cloudflare’s CF-Connecting-IP header and stored as hashes; local development without that header shares one client bucket. Expired-state, session, and counter cleanup is bounded per accepted sign-in. Record and restore writes additionally allow 120 requests per account and 1,200 requests globally per fixed minute, enforced transactionally before reading the body; local mode shares one 120-write bucket. These limits return HTTP 429 and Retry-After. Both serving modes reject framing with CSP frame-ancestors and X-Frame-Options headers.

Outside the main databases, the browser also uses:

| Location                     | Contents                                                              |
| ---------------------------- | --------------------------------------------------------------------- |
| `localStorage`               | Interface-language preference and an account/local-server mode marker |
| Cookies                      | Session token and temporary OAuth state                               |
| Service-worker Cache Storage | App shell, translations, artwork, and bundled demo files              |
| JavaScript memory            | Loaded application context and current screen/session state           |

Browser, local-server, and account libraries remain separate. Switching storage modes does not migrate records. Signing in does not upload the guest database, and signing out does not copy account records into it. Transfer data by exporting a backup in one mode and importing it in the other.

Guest data belongs to the browser profile and origin and can work offline once the app shell is cached. Account reads and writes require a connection: API responses use `no-store`, and the service worker bypasses `/api/*`. An unavailable or expired remembered account presents a sign-in/guest choice instead of silently switching storage. Local database mode also requires its server to be reachable and will not silently switch to browser storage if it becomes unavailable. There is no background synchronization queue for offline server-storage edits.

### Build and offline cache

```sh
npm run build
```

`tools/build.mjs` creates `dist/` from an explicit list of public files: the HTML entry point, service worker, JavaScript, styles, artwork, and bundled banks. It also generates metadata, routing/header files, a sitemap, and a 404 page. Pages Functions are maintained separately in `functions/`. Generated output is ignored by Git.

`sw.js` caches a fixed app shell and bundled demo files. Imported banks and images live in storage, separately from that cache. When changing cached frontend assets, update the cache version in `sw.js`; during development, unregister the worker in browser developer tools if stale assets persist.

## Repository layout

```text
.
├── index.html              App shell
├── js/                     Frontend modules and translations
├── styles/                 App and print styles
├── assets/                 Bundled artwork
├── banks/                  Original demo bank and its images
├── functions/api/          Account API
├── migrations/             D1 schema
├── server/                 Shared API validation
├── tools/                  Static/SQLite server and build utilities
├── tests/                  Unit, browser, and Pages integration tests
├── sw.js                   Offline cache
├── JSON_FORMAT.md          Question-bank schema and examples
├── .dev.vars.example       Local account configuration template
├── wrangler.toml           Local Pages/D1 configuration
├── playwright.config.js    Browser test configuration
├── Dockerfile              Static guest-mode image
└── package.json            Scripts and development dependencies
```

Commit source, tests, migrations, configuration templates, demo assets, and `package-lock.json`. Dependencies, build output, test artifacts, credentials, local databases, editor/agent state, and internal planning/review notes are excluded by `.gitignore`.

## Question banks and images

See [JSON_FORMAT.md](JSON_FORMAT.md) for the schema, all four question types, and a complete example. Start with [banks/demo.json](banks/demo.json), assign a unique bank ID, and keep question and option IDs stable across compatible updates.

Import JSON and its referenced images through the app's file pickers or drag-and-drop. The browser reads only selected files; it cannot automatically open sibling image files. Referenced images need unique basenames within an import selection. Missing images can be attached later from the bank card.

Supported images are SVG, PNG, JPEG, GIF, and WebP. SVGs are sanitized, raster signatures are checked, and imported images are stored with the bank and rendered using blob URLs. Imported paths are never fetched as arbitrary URLs.

Current limits include 512 KiB per bank JSON, 256 KiB per image, 512 KiB total selected images per bank, and 1 MiB per saved record including encoded images. Ordinary account transactions are limited to 2 MiB and 20,000 changes; account storage is limited to 20 MiB or 20,000 records. Backup restore automatically uploads smaller parts and commits the entire merge atomically, up to 24 MiB or 150,000 records. There is one private restore staging area per account (or local installation), expiring after 15 minutes; failed restores do not expose partial records. Failed uploads are cancelled when possible. Authenticated account requests reclaim expired uploads across all owners in bounded passes, and local mode also runs cleanup at startup and once per minute. Hosted cleanup runs when the service receives authenticated traffic, rather than at an exact wall-clock expiry. Full backup exports use compact JSON to avoid whitespace inflation. Libraries exceeding 16 MiB or 100,000 records per file open a download dialog with independently restorable parts. Download every part and restore them in order; each part merges atomically, while the complete set spans multiple merges. This supports guest and local libraries larger than the limit for one restore. The shared constants are in `js/limits.js`.

## Study, scoring, and backups

Open-ended questions use self-assessment after revealing the answer. Objective questions use exact correctness to choose Know or Repeat; partial credit is reported separately. Skips record history without advancing the schedule.

Study focuses on topics, new questions, and custom practice sessions (20 questions by default, adjustable up to 10,000). Ordering defaults to New first; Random and difficulty from easy to hard or hard to easy are also available. Due-date ordering belongs to Review. Review opens on questions due now and has separate Incorrect, Flagged, and Skipped groups. Incorrect uses the latest objective answer; answering clears Skipped, while flags stay until manually removed. Groups can overlap and all responses update the same progress. Exam-result review stays restricted to the selected exam’s questions.

Scheduling uses FSRS-6 through vendored `ts-fsrs` 5.4.2 with its supplied default model parameters. Repeat maps to Again; Know maps to Good. There is one 10-minute learning/relearning step, including when an established question is forgotten. Subsequent successful intervals depend on the memory state, elapsed time, and desired retention (default 90%, configurable from 70–97%). Higher retention generally requires more reviews. The maximum interval defaults to 180 days and is edited in days. Intervals preview before answering; fuzz is disabled so previews are deterministic. Personal parameter optimization is not implemented.

Existing v1 backups remain supported. Existing due dates are not bulk-rescheduled. On the next non-skip answer, a legacy state initializes an approximate FSRS memory state from its prior interval and last review, with neutral difficulty. Flags, skips, counters, and history are retained. FSRS memory state is stored as JSON-safe numeric timestamps inside the existing question state and included in normal backups. Legacy first-interval, minimum-interval, and multiplier preference fields remain in stored records for backup compatibility but no longer control scheduling. Scheduling works offline for guests; account and local-database writes retain their connection requirements.

Strict scoring awards one point only when the selected set exactly matches the correct set. Multiple-select partial credit is `clamp((selected correct − selected incorrect) / total correct, 0, 1)`. Unanswered objective questions remain in the score denominator; open-ended responses are assessed separately.

Exams autosave answers and use absolute deadlines, allowing a saved exam to resume or finalize after expiry. Only one active exam is supported. Concurrent editing across tabs is not coordinated. If final submission fails, answers freeze and automatic retries stop; the saved session remains available, with explicit submission retry and answer export controls.

Full backups include banks, images, settings, history, schedules, results, and the interrupted exam. Restore validates a backup and previews a merge before confirmation. Existing bank IDs and active sessions are kept; other conflicts generally use the newer record timestamp. Standalone bank JSON is imported through bank management, while standalone result exports are portable reports rather than full backups.

Guest storage can be cleared by the browser or its user. Download backups to preserve work or transfer it between devices and browser origins. The app contains no analytics, remote fonts, or telemetry.

## Tests

Run the Node test suite:

```sh
npm test
```

Run browser workflows with Chromium:

```sh
npm ci
npx playwright install chromium
npx playwright test
```

Playwright starts the local guest server automatically. Tests cover import, study/exam workflows, persistence, exports, language switching, and browser behavior.

Run the local Pages/D1 integration smoke test:

```sh
npm run test:pages
```

This builds the public files, applies migrations to an isolated temporary database, and checks API behavior, private-file exclusion, account persistence, and expired-session handling. OAuth tests mock Google's responses; interactive Google login requires the local credentials described above.

For the local SQLite backend, `npm test` includes HTTP/API persistence and rollback checks on supported Node versions. Run the local browser integration workflow with:

```sh
npm run test:local
```

It checks demo images, saved preferences, study history, exam submission, persistence across server restarts and fresh browser contexts, and failure without silently switching to guest storage when offline. It uses a temporary database and requires Playwright Chromium.
