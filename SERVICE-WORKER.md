# Offline cache lifecycle

GridSound is a browser DAW: after the user clicks **start**, `src/run.js`
loads the sample library (`assets/gsuiLibrarySamples-v1.js`) and the waveform
library (`assets/gsuiWaveletList-v1.js`) before initialising the DAW. If either
of them is missing from the offline cache, the application cannot boot without
a network connection.

The service worker therefore keeps **one cache per published version** and
never lets a fallback read the cache of another version.

## Files

| File | Role |
| --- | --- |
| `serviceWorker.js` | versioned install / activate / fetch lifecycle |
| `src/serviceWorkerLifecycle.js` | client side: registration, version pinning, cache fallback, waiting-version switch |
| `src/run.js` | startup flow; asks for the version switch when the user starts |
| `build-conf.json` | build source of truth: `version` (injected as `GSDAW-VERSION` into the page) and `jsSrcA` (includes `src/serviceWorkerLifecycle.js`) |
| `tools/check-service-worker.mjs` | local consistency checks |
| `tools/bump-version.mjs` | release tool: bumps the version everywhere |

## Where the version comes from

The version is not computed at runtime: it is a build-time constant, repeated
in three places that `tools/check-service-worker.mjs` keeps in sync:

1. `build-conf.json` → `"version"` — the value the build injects into the page
   (`{{GSDAW-VERSION}}` in `src/splashScreen.html`);
2. `serviceWorker.js` → `const VERSION`;
3. `src/serviceWorkerLifecycle.js` → `const GSDAW_VERSION`.

To check locally, without installing anything:

```sh
node tools/check-service-worker.mjs
```

It fails if the versions diverge, if a startup asset is not precached, if the
obsolete `gswaPeriodicWavesList-v1.js` comes back, or if the cache name stops
being derived from the version.

To release, run:

```sh
node tools/bump-version.mjs          # 2.60.2 -> 2.60.3
node tools/bump-version.mjs 2.61.0   # explicit version
```

## Lifecycle

### Install — `daw-<version>`

`PRECACHE_URLS` contains the page entry points (`/`, `/index.html`,
`/manifest.json`), the assets used by the splash screen, **and both startup
libraries**, with `gsuiWaveletList-v1.js` replacing the unused
`gswaPeriodicWavesList-v1.js`.

All requests use `cache: "reload"` so a new version never inherits an HTTP-cached
old copy. If one request fails, the installation is rolled back (unless the
cache already existed, in which case it is left untouched) and the previous
version keeps serving the application: a half-filled cache is never exposed.

`skipWaiting()` is **not** called during install. A newly installed version
stays in the *waiting* state, so a page that is already open keeps using the
version it was loaded with.

### Activate — cleanup and takeover

On activation every cache older than the version being activated is deleted:
that covers the legacy unversioned `daw` cache and any `daw-<older version>`
cache. A `daw-<newer version>` cache is deliberately kept: it can belong to an
installation in progress (v3 installing while v2 activates), and deleting it
would leave that version waiting with an empty cache. `self.clients.claim()`
then gives the new worker control of the pages already open, so their next
requests are served by the new version.

### Fetch — network first, current version only

Same-origin `GET` requests are fetched with `cache: "no-cache"` and fall back to
`caches.open(CACHE_NAME)` — never `caches.match()`, which would search every
cache, including a leftover one. `cache.has()` is checked first because
`caches.open()` would otherwise recreate a cache that has just been deleted.

### Startup loads and version pinning

`GSDAWOffline.loadScript()` (used by `src/run.js`) first loads the asset through
a regular `<script>` tag, which the worker transparently answers from the
current version's cache when offline. If that fails (no controller yet, network
down, ...), it reads the asset from the cache of the **version reported by the
controlling worker** (`GET_VERSION` message, falling back to the build
constant) and executes it as a classic script so its top-level bindings are
still visible to the rest of the application.

This is what makes a fallback version-correct: a page still controlled by
v1 reads `daw-2.60.2`, even when a v2 worker is waiting with its own
`daw-2.60.3` cache. If the entry is missing from that version's cache, the load
fails instead of borrowing the other version's copy.

### Update race

- A version installed while the page is open stays *waiting*: the old page
  keeps working unchanged, and its loads keep hitting the old cache.
- When the user clicks **start**, `src/run.js` calls
  `GSDAWOffline.activateWaitingVersion()` in parallel with the audio-context
  resume and awaits it before loading the libraries. If nothing is waiting, a
  bounded `registration.update()` looks for a fresh version first.
- The waiting worker is asked to `SKIP_WAITING`; the page waits for the
  `controllerchange` event (bounded by a timeout) and resolves
  `{ switched, version }`. Nothing is reloaded and no extra interaction is
  required: the startup flow simply continues, and the two library loads that
  follow now hit the new version's cache.
- If the switch does not complete in time, startup proceeds with the previous
  version; the next start will pick the waiting version up.

## Simulating an upgrade locally

1. Serve the project over HTTP on `localhost`/`127.0.0.1` (service workers
   require a secure context; the `file:` protocol does not work).
2. Open the application, click **start**, and wait for the DAW to be ready.
   In DevTools → Application → Cache Storage you should see exactly one cache,
   `daw-<version>`, containing `assets/gsuiWaveletList-v1.js`.
3. Bump the version, e.g. `node tools/bump-version.mjs`.
4. Reload the page. The new worker installs; in DevTools → Application →
   Service workers it is shown as *waiting*, and Cache Storage now holds both
   `daw-<old>` and `daw-<new>`. The page keeps running with the old version.
5. Click **start**. The waiting worker activates (`skipWaiting` via message),
   the page is *not* reloaded, and Cache Storage is left with `daw-<new>` only.
6. To check the offline path, stop the server (or switch DevTools to *Offline*)
   and reload: both libraries must still load, from `daw-<new>`.
7. To check that a leftover cache is never used, stop the network with a
   v2 worker waiting and delete `assets/gsuiWaveletList-v1.js` from
   `daw-<old>`: the old page must fail to load it rather than read the copy
   stored in `daw-<new>`.

`GSDAWOffline.$loads` records each startup load
(`{ url, source, version, cacheName }`) and `GSDAWOffline.activeVersion()` returns
the version in charge of the page; both are handy in the console.

## Automated checks

```sh
node tools/check-service-worker.mjs
```

is dependency-free and covers the static invariants listed above.

```sh
npm install --no-save playwright-core
CHROME=/path/to/chrome node tools/offline-e2e.mjs
```

runs the seven scenarios of the "Simulating an upgrade locally" section in a
real Chromium against the real `serviceWorker.js`, `src/serviceWorkerLifecycle.js`
and `src/run.js` (the libraries are replaced by distinguishable payloads). It
is opt-in because `playwright-core` and a browser binary are not dependencies
of this repository.
