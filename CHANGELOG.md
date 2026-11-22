# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Reworked playback state handling: playlist advancement (initial load, `ended` event, `NEXT` notification) now goes through a single code path that updates the index, played queue and video element together.
- Hide/show now records the pause reason: showing the module only resumes the video if it was paused by the hide, so a manual `TOGGLE` pause is no longer overridden.
- `REPLAY` now restarts the current clip (previously it could target the wrong list entry after a loop reset).
- `NEXT` at the end of the list with `loop: false` (or with an empty list) now stops safely instead of throwing.
- `hideonstart` hides once per clip after playback starts and can no longer re-trigger the pause logic in a loop.
- Added a local test suite (`npm test`) covering the playlist, hide/show and notification state transitions.
- Matched the package name in `package-lock.json` to `package.json`, so npm no longer rewrites the lockfile on install.
- Documentation and repository maintenance updates
- Added ESLint configuration for local checks
