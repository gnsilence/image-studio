# Nova Image Studio Electron + SQLite Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows x64 Electron client that runs the existing Nova task service locally, stores durable desktop data in SQLite plus managed files, imports existing Web backups, and updates from a fixed HTTPS feed without breaking Web/Docker deployments.

**Architecture:** Electron owns the application window, durable database, file store, encrypted secrets, backup operations, and updater. The existing Node server runs in an Electron utility process on an ephemeral loopback port and retains its HTTP/WebSocket contract. Renderer storage modules select either the existing browser implementation or a narrow preload bridge.

**Tech Stack:** Electron, electron-builder, electron-updater, better-sqlite3, Next.js static export, React, Node.js HTTP/WebSocket, fflate, Vitest, Node test runner.

---

### Task 1: Make the backend lifecycle manageable

**Files:**
- Modify: `backend/server.js`
- Create: `backend/server.test.js`

- [ ] Export `startServer()` and `stopServer()` while preserving direct `node backend/server.js` startup.
- [ ] Accept `PORT=0`, report the actual bound port, bind Electron launches to `127.0.0.1`, and close HTTP, WebSocket, timers, and SQLite on shutdown.
- [ ] When `NOVA_DESKTOP_SESSION_TOKEN` exists, require `X-Nova-Desktop-Token` for `/api/nova/*` and WebSocket upgrades; leave Web/Docker behavior unchanged when absent.
- [ ] Run `node --test backend/server.test.js` and verify dynamic-port startup, missing-token rejection, valid-token access, and clean shutdown.

### Task 2: Add the desktop SQLite and file store

**Files:**
- Create: `desktop/storage/database.js`
- Create: `desktop/storage/file-store.js`
- Create: `desktop/storage/secret-store.js`
- Create: `desktop/storage/storage-service.js`
- Create: `desktop/storage/storage.test.js`

- [ ] Create commented migrations for `schema_migrations`, `app_settings`, `app_secrets`, `app_records`, and `stored_files`, including indexes by namespace and update/access time.
- [ ] Run migrations transactionally, checkpoint and back up an existing database before version changes, then require `PRAGMA quick_check` to return `ok`.
- [ ] Implement allowlisted configuration keys and namespaced record CRUD using prepared statements and JSON validation.
- [ ] Store files under generated namespace/id paths with temporary-file plus atomic-rename writes; reject unknown namespaces, invalid ids, and paths outside the data root.
- [ ] Encrypt/decrypt model API keys through an injected Electron `safeStorage` adapter, and reject persistence when encryption is unavailable.
- [ ] Run `node --test desktop/storage/storage.test.js` and verify migrations, CRUD, encrypted registry storage, atomic files, traversal rejection, and cleanup.

### Task 3: Add Electron runtime and preload boundary

**Files:**
- Create: `desktop/main.js`
- Create: `desktop/preload.js`
- Create: `desktop/backend-process.js`
- Create: `desktop/ipc.js`
- Create: `desktop/updater.js`
- Create: `desktop/bridge-contract.d.ts`

- [ ] Set Electron `userData` to `%LOCALAPPDATA%\Nova Image Studio`, acquire the single-instance lock, and create a secure BrowserWindow with context isolation and no renderer Node integration.
- [ ] Start `backend/server.js` with `utilityProcess.fork`, ephemeral loopback port, task database/image paths, and a random desktop session token; wait for a structured ready message before loading the window.
- [ ] Attach the session token only to the managed loopback origin, deny arbitrary navigation/windows, and open approved external HTTPS links with the system browser.
- [ ] Register IPC handlers for synchronous config, asynchronous records/files/backups, updater status, data-directory access, and task-aware shutdown.
- [ ] Expose only the typed `window.novaDesktop` bridge from preload; never expose `ipcRenderer`, filesystem paths, shell, or arbitrary channel names.

### Task 4: Adapt renderer persistence without changing Web storage

**Files:**
- Create: `frontend/src/lib/desktop-bridge.ts`
- Create: `frontend/src/lib/runtime-storage.ts`
- Modify: `frontend/src/lib/settings-storage.ts`
- Modify: `frontend/src/lib/nova-models.ts`
- Modify: `frontend/src/lib/job-store.ts`
- Modify: `frontend/src/lib/image-downloader.ts`
- Modify: `frontend/src/lib/asset-store.ts`
- Modify: `frontend/src/lib/agent-context-store.ts`
- Modify: `frontend/src/lib/reverse-prompt-store.ts`
- Modify: `frontend/src/lib/upload-image-cache.ts`
- Modify: `frontend/src/components/canvas/lib/localforage-storage.ts`
- Modify: `frontend/src/components/canvas/lib/image-storage.ts`

- [ ] Add a runtime bridge detector and synchronous config adapter covering every actual setting key, including `nova-image-generation-settings` and `nova-gif-tuner-mobile-hint-hidden`.
- [ ] Keep all Web branches on localStorage/IndexedDB/localforage and route Electron branches through namespaced record/file APIs.
- [ ] Preserve current public function signatures and stored reference formats where feasible so workbench, Agent, assets, reverse prompt, GIF, and canvas components do not need behavioral rewrites.
- [ ] Add frontend tests that stub `window.novaDesktop` and verify desktop persistence plus unchanged browser fallback.
- [ ] Run `npm run test:run`, `npm run lint`, and a normal `npm run build`.

### Task 5: Implement compatible backup import/export

**Files:**
- Create: `desktop/storage/backup-service.js`
- Modify: `frontend/src/lib/backup-utils.ts`
- Modify: `frontend/src/components/SettingsModal.tsx`

- [ ] Export the existing `metadata.json`, `localStorage.json`, `indexedDB/*.json`, `localforage/*.json`, and `blobs/*` layout from desktop records/files while stripping API keys.
- [ ] Import both current and legacy backup records into a staging database and staging file directory; validate ZIP entry paths, allowed databases/stores, JSON shapes, and total expanded size before swap.
- [ ] Encrypt imported model API keys immediately, atomically replace durable data, and restore the previous database/directory when swap or startup validation fails.
- [ ] Keep the existing Web backup implementation and choose the desktop service only when the preload bridge exists.
- [ ] Test valid round trips, missing blobs, malformed JSON, ZIP traversal names, rollback, plaintext-secret absence, and Web-format compatibility.

### Task 6: Package and update the Windows client

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `frontend/next.config.ts`
- Modify: `frontend/src/components/ServiceWorkerManager.tsx`
- Create: `electron-builder.yml`
- Create: `scripts/desktop-build.js`
- Create: `desktop/updater.test.js`

- [ ] Add Electron, electron-builder, electron-updater, and aligned backend runtime dependencies at the root so packaged backend resolution and native rebuilding are deterministic.
- [ ] Add desktop development, directory-build, and NSIS distribution scripts; require `NOVA_UPDATE_URL` for distributable builds.
- [ ] Disable next-pwa for `NOVA_DESKTOP_BUILD=1`, include frontend static output/backend/resources/LICENSE, unpack native `.node` binaries, and generate a per-user Windows x64 NSIS target.
- [ ] Configure generic-provider updates using the build-time HTTPS URL, delayed startup checks, six-hour polling, background download, task-aware restart, and renderer status events.
- [ ] Run `npm run desktop:build`, inspect the unpacked app, run the packaged smoke test with a temporary data directory, then run `npm run desktop:dist` against a test update URL and verify `.exe`, `.blockmap`, and `latest.yml`.

### Task 7: Final regression and acceptance

**Files:**
- Modify: `README.md`

- [ ] Document Windows installation, LOCALAPPDATA layout, Web backup migration, API-key behavior, unsigned-build warning, update-server requirements, development commands, and data recovery.
- [ ] Run backend tests, desktop storage/updater tests, frontend Vitest, frontend/backend lint, normal Web build, desktop build, and Docker-context build validation.
- [ ] Install the NSIS package, persist settings and representative history/assets/canvas data, restart, import a Web backup, export a key-free backup, exercise a test update, and verify uninstall leaves the data directory intact.
- [ ] Inspect `git diff --check`, `git status --short`, and the full diff; remove only artifacts created by the implementation and leave unrelated user files untouched.
