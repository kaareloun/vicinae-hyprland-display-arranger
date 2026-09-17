# Hyprland Display Arranger — agent notes

Vicinae extension. Reorder, position, enable/disable Hyprland displays from the launcher.
Runtime state via `hyprctl`, persistence via an owned sidecar Lua file required from `hyprland.lua`.

## Layout

- `src/arrange-displays.tsx` — the single `view` command (list, detail, edit-position form).
- `src/lib/hypr.ts` — all Hyprland logic: `hyprctl` calls, layout math, sidecar read/write.
- `assets/extension_icon.png` — 512x512 store icon. `assets/screenshot.png` — README screenshot.

## Style rules

1. No comments in code by default. Rationale lives here, not in `src/`.
2. Format with biome before committing: `npm run format` (`biome format --write src`).
3. Prefer early return over if/else and ternaries.
3. React component files export only the component.
4. Reuse existing UI components; extract new shared ones when a second use appears.
5. Fix LSP errors immediately.
6. Don't run `npm run build` until the feature is done. Don't start a dev server unless necessary.

## Pre-PR verification (vicinaehq/extensions AI reviewer)

Every PR to `vicinaehq/extensions` gets an automated review plus CI. Policy source of truth:

- `https://raw.githubusercontent.com/vicinaehq/extensions/main/skills/extension-reviewer/SKILL.md`
- `https://raw.githubusercontent.com/vicinaehq/extensions/main/skills/extension-reviewer/rules.json`

Blocking rules and how this extension stays clear of them:

1. `SECURITY-002` (injection) — highest risk surface here. `hyprctl` JSON output and the
   `managed-file` preference both end up in generated Lua. Keep: `execFile` with a fixed
   binary + arg array (never shell strings); `luaStr` escaping quotes/backslashes/newlines
   and stripping other control chars; `sanitizeSidecarFile` rejecting anything that isn't
   a plain `*.lua` basename. Never interpolate dynamic data into shell or Lua without both.
   Numeric fields interpolated raw into Lua (`scale`) go through `scaleFor`, which
   coerces non-finite values to 1 — a hostile `hyprctl` string can't become Lua syntax.
2. `SECURITY-003` (sensitive data) — no credentials, tokens, or camera/mic-style temp files
   in this extension. Don't add any.
3. `SECURITY-001` (downloaded executables) — never download or bundle binaries.
   `hyprctl` is a documented host dependency the user installs.
4. `CORRECTNESS-001` (logic errors) — reviewer only flags high-confidence, observable-wrong
   behavior. Preserve custom Y offsets across move/refresh/persist (`tileHorizontallyKeepY`);
   guard `Math.max` over possibly-empty lists; keep `mergeOrder` stable across polls.
5. `DECEPTION-001` / `MANIFEST-001` — store copy must match behavior. `platforms: ["Linux"]`
   is required (Hyprland-only). Toasts must say "Session only" whenever a change applied
   live on hyprlang without persisting.
6. `UX-001` (error feedback) — every `hyprctl`/fs failure needs a toast or `EmptyView`.
   The 2s background poll keeps the stale list but toasts once per outage (first
   failure after data is shown; silent again until recovery); initial `load()` owns
   error display.
7. `UX-002` (loading/empty states) — async forms need `isLoading`; empty results need
   `EmptyView`. The zero-monitor case has one.
8. `API-001` — prefer `@vicinae/api` over custom code when it covers the use case.
   `node:child_process`/`fs`/`os`/`path` are required here (no Vicinae equivalent).
9. `PROCESS-001` — `hyprctl` spawns are short-lived `execFile` calls with a timeout.
   Never detach or leave children running.
10. `NETWORK-001`, `UX-003`, `FUNCTIONALITY-001`, `QUALITY-001`, `DEPENDENCY-001`,
    `ASSET-001` — no network, English-only strings, not a Vicinae duplicate, no dead or
    generated code in `src/`, only `@vicinae/api` as a runtime dependency, ordinary images.

## Pre-PR commands

1. `npm run format`
2. `npx tsc --noEmit`
3. `npm run lint` (must print "Manifest is valid")
4. `npm run build`
5. Pure-logic check: `npx tsx` script asserting `sanitizeSidecarFile` rejects
   `../`, `/`, quotes, missing `.lua`; `liveEntry` output for a hostile
   `desc:` value is single-line with escaped quotes/newlines; `tileHorizontallyKeepY`
   keeps Y while tiling X; `scaleFor` coerces non-finite scales to 1.
6. In the `vicinaehq/extensions` fork: extension lives at
   `extensions/hyprland-display-arranger/`, PR includes `package-lock.json` and excludes
   `node_modules/`, `dist/`, `vicinae-env.d.ts`. Upstream CI runs
   `bun scripts/validate-extension.ts hyprland-display-arranger` (also verifies `author`
   is a real GitHub user), `npm ci`, and `vici build`.
