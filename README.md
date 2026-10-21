# Quitsar

:warning: This is a vibe-coded experiment. The app has automated tests and has had a brief code review, but no deep review. Use with caution.

A study and practice-exam app. Import question banks, practice by topic or difficulty, review with spaced repetition, and take configurable exams.

Run locally with data stored in your browser or in a single-user SQLite database on the host. Both options are also available through Docker.

## Features

- Open-ended, single-choice, multiple-choice, and image-recognition questions.
- Filters for banks, topics, subtopics, tags, difficulty, and question type.
- Study sessions with new-first, random, easy-to-hard, or hard-to-easy ordering.
- A review queue for due, incorrect, flagged, and skipped questions.
- Timed or untimed exams with autosave, interrupted-session recovery, and strict or partial scoring.
- Explanations, detailed results, print views, and JSON/CSV exports.
- Question-bank imports with images, an import-format guide, and a copyable prompt for your AI tool.
- Full-library backups and restore.
- English, Slovak, Czech, German, Spanish, and French interfaces; light, dark, and system themes.

## Local deployment

Use **Node.js 22.13 or newer**; the preferred version is recorded in `.node-version`.

For guest mode, start the dependency-free local server:

```sh
npm start
```

Open **http://127.0.0.1:8080** to start with the included high-school biology bank. It loads automatically when your library is empty, with 12 questions on cells, genetics, and ecosystems. Importing your own bank replaces this automatic demo; an explicitly loaded demo can stay alongside your material. **Exam simulator** includes a quick quiz, a timed practice exam, and written-answer practice, each with a preview before starting. You can also load the demo explicitly from **Question banks → Try the demo bank**. Use HTTP rather than opening `index.html` directly: modules, browser storage, and service workers require a suitable origin.

Wait for **Offline cache ready** before stopping the server. Later visits can work offline at the same hostname and port in browsers that support service workers. Guest data belongs to that browser profile and origin; switching between `localhost` and `127.0.0.1`, or changing ports, opens a separate store.

Both local modes use Node’s built-in modules. No dependency installation, build step, or separate database service is required.

### Single-user local database

To keep the library on the host instead of in each browser, start the optional SQLite backend:

```sh
npm run start:local
```

Open **http://127.0.0.1:8080**. The app detects local database mode automatically. There is one library for the installation, with no login, password, or Google configuration. All banks, imported images, progress, history, settings, completed exams, and the active exam are stored in **`.data/quitsar.sqlite`**. The file and its SQLite journal files are ignored by Git and cannot be downloaded through the static server.

The database is created automatically, and applicable local schema updates run at startup. Configuration is optional:

| Option            | Default                                       | Purpose                                                                                     |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `STORAGE_MODE`    | `browser`                                     | Set to `local` to enable SQLite; `start:local` selects it unless this variable overrides it |
| `LOCAL_DB_PATH`   | `.data/quitsar.sqlite` under the project root | SQLite file path; relative overrides resolve from the working directory                     |
| `HOST`            | `127.0.0.1`                                   | HTTP bind address                                                                           |
| `ALLOWED_ORIGINS` | empty                                         | Comma-separated additional HTTP origins permitted to access the local API                   |
| `PORT`            | `8080`                                        | HTTP port                                                                                   |

For example:

```sh
STORAGE_MODE=local LOCAL_DB_PATH=/path/to/library.sqlite PORT=8081 npm start
```

Keep the server running while studying: database reads and writes require a connection to it, even when the app shell is cached. Browser profiles accessing the same installation share the same library. Anyone who can reach this server has access to that library; the default loopback bind keeps access on the host machine. There is no per-user separation or simultaneous-edit conflict resolution. The API accepts loopback hostnames and the explicit bind address even when bound to every interface in Docker. For a LAN hostname, set an explicit origin such as `ALLOWED_ORIGINS=http://study.internal:8080`; arbitrary Host headers are rejected independently of `HOST`.

Existing browser data is not migrated automatically. Export a full backup from the original mode, start local database mode, and restore it through **Backup & export**. To copy the database file directly, stop the server first so committed SQLite journal data is checkpointed; the app's full backup export is also supported.

## Docker

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

Stop either container with `docker stop quitsar`. To update, stop the container, rebuild the image, and run the same command again. Reuse the named volume to keep the SQLite library.

For LAN access, change the port mapping to `-p 8080:8080` and add an explicit allowed origin, for example `-e ALLOWED_ORIGINS=http://192.168.1.10:8080`, using your server’s address. Local database mode has no authentication; anyone who can reach it can access the shared library. Service-worker offline caching requires localhost or HTTPS.

## Question banks and images

See [JSON_FORMAT.md](JSON_FORMAT.md) for the schema, all four question types, and a complete example. Start with [banks/demo.json](banks/demo.json), assign a unique bank ID, and keep question and option IDs stable across compatible updates.

Import JSON and its referenced images through the app's file pickers or drag-and-drop. The browser reads only selected files; it cannot automatically open sibling image files. Referenced images need unique basenames within an import selection. Missing images can be attached later from the bank card.

Supported images are SVG, PNG, JPEG, GIF, and WebP. SVGs are sanitized, raster signatures are checked, and imported images are stored with the bank and rendered using blob URLs. Imported paths are never fetched as arbitrary URLs.

## Backups and moving data

Use **Backup & export** to download a full backup containing banks, images, settings, history, schedules, results, and the unfinished exam. Restore previews a merge before confirmation. If an export is split into multiple files, download every part and restore them in order.

Browser storage and local SQLite storage are separate. To switch modes or move to another device, export from the original library and restore into the destination. The app does not transfer data automatically.

Browser settings and storage eviction can clear guest data. Keep downloaded backups outside the browser. To copy a SQLite database directly, stop the server or container first, then copy the database after shutdown.

## Development checks

Install development dependencies and run the unit tests:

```sh
npm ci
npm test
```

Install Chromium and run browser workflows:

```sh
npx playwright install chromium
npx playwright test
```

The browser tests start their own server on port 8080; stop any app instance using that port first.

To check local SQLite persistence, exam workflows, and restart recovery:

```sh
npm run test:local
```

The local integration check requires Playwright Chromium and uses a temporary database.
