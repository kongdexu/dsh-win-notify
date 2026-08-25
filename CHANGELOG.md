# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-08-25

### Added

- First engineered release of the plugin previously maintained in-profile as
  the ad-hoc `dsh-notify.mjs` + `.dsh-notify/` helper pair, now packaged as the
  npm bundle **`dsh-win-notify`** (the bare `dsh-notify` name was already taken
  on npm by another author, so the package name carries the Windows-only flag).
- Standard release scaffolding mirroring `dsh-nav-pointer`:
  - `package.json` with `dsh.bundle.patch` (auto-joins `dsh.profile.bundles`
    on `dsh plugin --profile web add dsh-win-notify`) and `"os": ["win32"]`.
  - TypeScript sources under `src/` (`core.ts` = React/ctx-free pure logic,
    `index.ts` = plugin entry), built by esbuild into `lib/` (`build.mjs`),
    with `lib/.dsh-notify/` shipping the helper assets next to the entry.
  - vitest behavior tests (`test/core.test.ts`, `test/plugin.test.ts`) and a
    built-artifact smoke contract (`test/smoke.mjs`); `npm run check` runs
    typecheck → build → vitest → smoke; CI (Windows) enforces committed
    `lib/` matches `src/`.
  - `README.md`, `docs/DEVELOPMENT.md`, `LICENSE` (MIT), `.github/workflows`.
- Windows-only runtime guard: on non-Windows hosts `apply()` logs once and
  registers nothing, so installing the package on Linux/macOS is harmless.

### Changed

- Plugin name in loader diagnostics changed `dsh-notify` → `dsh-win-notify` to
  match the package (`cordis.patch.yml` row id/name updated accordingly).
- Helper paths now resolve from the built entry (`lib/index.js` →
  `lib/.dsh-notify/`), keeping the published package self-contained.

### Notes (pre-0.1.0 development history)

The plugin was built and fixed in five rounds while living inside the profile:

1. **Icon never displayed** — Windows resolves toast identity through
   AUMID → Start-Menu shortcut → embedded icon; for non-MSIX apps that chain
   was unreliable. Fixed by pointing the shortcut `SetIconLocation` and
   registry `IconUri` at the multi-frame `notify.ico`.
2. **Oversized / missing small icon** — `notify.ico` was regenerated with 9
   real frames (16…256 px, transparent corners + black-background white whale);
   the toast XML `<image>` (rendered as a giant circle in Notification Center)
   was removed. Icon now comes from the AUMID identity channel at the proper
   small size. Stale icon needs a re-login/reboot to refresh Windows' cache.
3. **AUMID never persisted** — `IPersistFile.Save → IPropertyStore.Commit`
   only wrote the property into memory; the link must be `Save`d **again**
   after `Commit` for `AppUserModelID` to land on disk (verified empirically:
   lnk read back `vt=0`). Fixed in `DshToast.cs`.
4. **Subagent spam + lost titles** — `agent/status` fires for every agent;
   the old single global flag made any background worker's completion raise a
   toast. Replaced with per-agent `WeakMap` state, `origin: "subagent"`
   session-header filtering, a 10s per-agent completion cooldown, and direct
   `sessionTitle.get(agent.session)` resolution.
5. **Late "需要您的输入"** — toasts fired on `tools/result`, i.e. *after* the
   user had already answered. Moved to `tools/execute` (the waterfall must be
   released with `return next()`; the observer never short-circuits tools).