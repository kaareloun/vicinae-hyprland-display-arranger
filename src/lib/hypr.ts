import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HyprMonitor {
  id: number;
  name: string;
  description: string;
  make: string;
  model: string;
  serial: string;
  width: number;
  height: number;
  refreshRate: number;
  x: number;
  y: number;
  scale: number;
  transform: number;
  focused: boolean;
  disabled: boolean;
  dpmsStatus: boolean;
  mirrorOf: string;
}

export type ConfigProvider = "lua" | "hyprlang" | "unknown";

export interface ConfigState {
  provider: ConfigProvider;
  luaPath: string;
  confPath: string;
  hyprDir: string;
  hasLua: boolean;
  hasConf: boolean;
  isLegacy: boolean;
}

export interface PlacedMonitor {
  monitor: HyprMonitor;
  x: number;
  y: number;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function getAllMonitors(): Promise<HyprMonitor[]> {
  const out = await run("hyprctl", ["monitors", "all", "-j"]);
  return JSON.parse(out) as HyprMonitor[];
}

export async function getProvider(): Promise<ConfigProvider> {
  try {
    const out = await run("hyprctl", ["status", "-j"]);
    const parsed = JSON.parse(out) as { configProvider?: string };
    if (parsed.configProvider === "lua") return "lua";
    if (parsed.configProvider === "hyprlang") return "hyprlang";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function hyprDir(): string {
  return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "hypr") : join(homedir(), ".config", "hypr");
}

export const TAKEOVER_COMMENT = "-- vicinae: managed display setup (extension-owned)";
export const OFF_PREFIX = "-- vicinae-off: ";
export const SIDECAR_DEFAULT = "displays-vicinae.lua";

export function requireLineFor(fileName: string): string {
  return `require("${fileName.replace(/\.lua$/, "")}")`;
}

function isStaticMonitorCall(line: string): boolean {
  if (line.startsWith("--")) return false;
  return /^hl\.monitor\s*\(\s*\{/.test(line);
}

function feedBraces(line: string, state: { depth: number; seenOpen: boolean; inStr: boolean; esc: boolean }): boolean {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (state.inStr) {
      if (state.esc) state.esc = false;
      else if (c === "\\") state.esc = true;
      else if (c === '"') state.inStr = false;
      continue;
    }
    if (c === '"') {
      state.inStr = true;
      continue;
    }
    if (c === "-" && line[k + 1] === "-") break;
    if (c === "{") {
      state.depth++;
      state.seenOpen = true;
    } else if (c === "}") {
      state.depth--;
      if (state.seenOpen && state.depth === 0) return true;
    }
  }
  return false;
}

function splitTopLevelCalls(source: string): string[][] {
  const lines = source.split("\n");
  const calls: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isStaticMonitorCall(lines[i])) {
      i++;
      continue;
    }
    const state = { depth: 0, seenOpen: false, inStr: false, esc: false };
    const block: string[] = [];
    while (i < lines.length) {
      block.push(lines[i]);
      const done = feedBraces(lines[i], state);
      i++;
      if (done) break;
    }
    calls.push(block);
  }
  return calls;
}

const ALLOWED_LITERAL_TOKENS = new Set(["true", "false", "nil"]);

function blockIsSelfContained(block: string[]): boolean {
  const body = block.join("\n");
  const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
  const noStrings = inner.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const noKeys = noStrings.replace(/[A-Za-z_][A-Za-z0-9_.]*\s*=/g, "=");
  const tokens = noKeys.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  return tokens.every((t) => ALLOWED_LITERAL_TOKENS.has(t) || /^[0-9.]+$/.test(t));
}

function parseRuleOutput(blockText: string): string | null {
  const m = blockText.match(/output\s*=\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

export interface ImportedRule {
  output: string;
  text: string;
}

export function importStaticRules(source: string): { rules: ImportedRule[]; skipped: string[] } {
  const byOutput = new Map<string, string>();
  const skipped: string[] = [];
  for (const block of splitTopLevelCalls(source)) {
    const text = block.join("\n");
    const output = parseRuleOutput(text);
    if (output === null || !blockIsSelfContained(block)) {
      skipped.push(output ?? block[0].trim().slice(0, 40));
      continue;
    }
    byOutput.set(output, text);
  }
  return { rules: [...byOutput].map(([output, ruleText]) => ({ output, text: ruleText })), skipped };
}

export function stripOwnMarkers(source: string): { text: string; stripped: number } {
  let stripped = 0;
  const text = source
    .split("\n")
    .map((l) => {
      if (l.startsWith(OFF_PREFIX)) {
        stripped++;
        return l.slice(OFF_PREFIX.length);
      }
      return l;
    })
    .join("\n");
  return { text, stripped };
}

export function monitorMatchesOutput(m: HyprMonitor, output: string): boolean {
  if (output === m.name) return true;
  if (m.description && output === `desc:${m.description}`) return true;
  return false;
}

export async function getConfigState(): Promise<ConfigState> {
  const dir = hyprDir();
  const luaPath = join(dir, "hyprland.lua");
  const confPath = join(dir, "hyprland.conf");
  const [provider, luaContent, hasConf] = await Promise.all([
    getProvider(),
    fs.readFile(luaPath, "utf8").catch(() => null),
    fs.access(confPath).then(() => true, () => false),
  ]);
  const hasLua = luaContent !== null;
  const isLegacy = provider === "hyprlang" || (provider !== "lua" && hasConf && !hasLua);
  return { provider, luaPath, confPath, hyprDir: dir, hasLua, hasConf, isLegacy };
}

export function scaledWidth(m: HyprMonitor): number {
  const rotated = Math.abs(m.transform) % 2 === 1;
  const w = rotated ? m.height : m.width;
  return Math.round(w / (m.scale || 1));
}

export function scaledHeight(m: HyprMonitor): number {
  const rotated = Math.abs(m.transform) % 2 === 1;
  const h = rotated ? m.width : m.height;
  return Math.round(h / (m.scale || 1));
}

export function orderLeftToRight(monitors: HyprMonitor[]): HyprMonitor[] {
  return [...monitors].sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name));
}

export function tileHorizontally(ordered: HyprMonitor[], startX = 0, y = 0): PlacedMonitor[] {
  let cursor = startX;
  return ordered.map((monitor) => {
    const placed = { monitor, x: cursor, y };
    cursor += scaledWidth(monitor);
    return placed;
  });
}

export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const idx = ids.indexOf(id);
  if (idx === -1) return ids;
  const next = idx + dir;
  if (next < 0 || next >= ids.length) return ids;
  const copy = [...ids];
  [copy[idx], copy[next]] = [copy[next], copy[idx]];
  return copy;
}

function luaStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function stableOutput(m: HyprMonitor): string {
  if (m.serial && m.description && m.description.includes(m.serial)) return `desc:${m.description}`;
  return m.name;
}

export function modeFor(m: HyprMonitor): string {
  return `${m.width}x${m.height}@${m.refreshRate.toFixed(2)}`;
}

export function evalForPlacement(m: HyprMonitor, x: number, y: number): string {
  return `hl.monitor({ output = ${luaStr(m.name)}, mode = ${luaStr(modeFor(m))}, position = ${luaStr(`${x}x${y}`)}, scale = ${m.scale} })`;
}

export function evalForDisable(m: HyprMonitor): string {
  return `hl.monitor({ output = ${luaStr(m.name)}, disabled = true })`;
}

export function legacyKeywordFor(m: HyprMonitor, x: number, y: number): string {
  return `monitor=${m.name},${modeFor(m)},${x}x${y},${m.scale}`;
}

export interface MoveStep {
  monitor: HyprMonitor;
  x: number;
  y: number;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function planStagedMoves(current: HyprMonitor[], placements: PlacedMonitor[]): MoveStep[] {
  const target = new Map(placements.map((p) => [p.monitor.name, p]));
  const pos = new Map(current.map((m) => [m.name, { x: m.x, y: m.y }]));
  const byName = new Map(current.map((m) => [m.name, m]));
  const pending = placements
    .filter((p) => {
      const c = pos.get(p.monitor.name);
      return !c || c.x !== p.x || c.y !== p.y;
    })
    .map((p) => p.monitor.name);

  let stageX =
    Math.max(...current.map((m) => m.x + scaledWidth(m)), ...placements.map((p) => p.x + scaledWidth(p.monitor))) + 64;
  const steps: MoveStep[] = [];

  const targetIsFree = (name: string): boolean => {
    const t = target.get(name);
    if (!t) return true;
    const tr = { x: t.x, y: t.y, w: scaledWidth(t.monitor), h: scaledHeight(t.monitor) };
    return !current.some((o) => {
      if (o.name === name) return false;
      const op = pos.get(o.name);
      if (!op) return false;
      return rectsOverlap(tr, { x: op.x, y: op.y, w: scaledWidth(o), h: scaledHeight(o) });
    });
  };

  let guard = pending.length * 3 + 4;
  while (pending.length > 0 && guard-- > 0) {
    const idx = pending.findIndex(targetIsFree);
    if (idx !== -1) {
      const name = pending.splice(idx, 1)[0];
      const t = target.get(name);
      if (!t) continue;
      pos.set(name, { x: t.x, y: t.y });
      steps.push({ monitor: t.monitor, x: t.x, y: t.y });
    } else {
      const name = pending.shift();
      if (!name) break;
      const m = byName.get(name) ?? target.get(name)?.monitor;
      if (!m) continue;
      pos.set(name, { x: stageX, y: 0 });
      steps.push({ monitor: m, x: stageX, y: 0 });
      stageX += scaledWidth(m) + 64;
      pending.push(name);
    }
  }
  for (const name of pending) {
    const t = target.get(name);
    if (t) steps.push({ monitor: t.monitor, x: t.x, y: t.y });
  }
  return steps;
}

export async function applyPlacements(placements: PlacedMonitor[], provider: ConfigProvider): Promise<void> {
  // NOTE: applied one call at a time, not via `hyprctl --batch`.
  // A batch of two hl.monitor evals returns ok but silently applies nothing.
  // Live positions are re-read first so the plan never starts from stale state.
  // Moves are staged through a free area first so no intermediate state
  // ever overlaps — otherwise Hyprland warns about a broken layout.
  const live = await getAllMonitors();
  const current = live.filter((m) => !m.disabled);
  for (const s of planStagedMoves(current, placements)) {
    if (provider === "lua") {
      await run("hyprctl", ["eval", evalForPlacement(s.monitor, s.x, s.y)]);
    } else {
      await run("hyprctl", ["keyword", legacyKeywordFor(s.monitor, s.x, s.y)]);
    }
  }
}

export async function setEnabled(m: HyprMonitor, enabled: boolean, provider: ConfigProvider): Promise<void> {
  if (provider === "lua") {
    if (!enabled) {
      await run("hyprctl", ["eval", evalForDisable(m)]);
      return;
    }
    await run("hyprctl", [
      "eval",
      `hl.monitor({ output = ${luaStr(m.name)}, mode = ${luaStr(modeFor(m))}, position = "auto", scale = ${m.scale} })`,
    ]);
    return;
  }
  if (!enabled) {
    await run("hyprctl", ["keyword", `monitor=${m.name},disable`]);
    return;
  }
  await run("hyprctl", ["keyword", `monitor=${m.name},${modeFor(m)},auto,${m.scale}`]);
}

export interface SidecarEntry {
  output: string;
  text: string;
}

export function liveEntry(p: PlacedMonitor): SidecarEntry {
  return {
    output: stableOutput(p.monitor),
    text: `hl.monitor({ output = ${luaStr(stableOutput(p.monitor))}, mode = ${luaStr(modeFor(p.monitor))}, position = ${luaStr(`${p.x}x${p.y}`)}, scale = ${p.monitor.scale} })`,
  };
}

export function disabledEntry(m: HyprMonitor): SidecarEntry {
  return { output: stableOutput(m), text: `hl.monitor({ output = ${luaStr(stableOutput(m))}, disabled = true })` };
}

export function renderSidecar(entries: SidecarEntry[]): string {
  const lines = ["-- Managed by vicinae hyprland-display-arranger. Do not edit by hand.", "-- Positions update on every change in Arrange Displays.", ""];
  for (const e of entries) lines.push(e.text, "");
  return lines.join("\n");
}

export interface EnsureResult {
  sidecar: string;
  changedConfig: boolean;
  persisted: boolean;
  imported: number;
  skipped: string[];
  migrated: number;
}

async function verifyLiveSet(expectedEnabled: Set<string>): Promise<void> {
  await run("hyprctl", ["reload"]);
  await new Promise((r) => setTimeout(r, 1500));
  const live = await getAllMonitors();
  const got = new Set(live.filter((m) => !m.disabled).map((m) => m.name));
  const same = got.size === expectedEnabled.size && [...got].every((n) => expectedEnabled.has(n));
  if (!same) throw new Error(`Post-reload check failed (active: ${[...got].join(", ") || "none"})`);
}

export async function persistLiveLayout(sidecarFile = SIDECAR_DEFAULT): Promise<EnsureResult> {
  const empty: EnsureResult = { sidecar: "", changedConfig: false, persisted: false, imported: 0, skipped: [], migrated: 0 };
  const provider = await getProvider();
  if (provider !== "lua") return empty;
  const dir = hyprDir();
  const luaPath = join(dir, "hyprland.lua");
  const luaCurrent = await fs.readFile(luaPath, "utf8").catch(() => {
    throw new Error("hyprland.lua not found");
  });
  const live = await getAllMonitors();
  const enabled = orderLeftToRight(live.filter((m) => !m.disabled));
  const disabled = live.filter((m) => m.disabled);

  let luaNext = luaCurrent;
  let changedConfig = false;
  let migrated = 0;
  if (luaNext.includes(OFF_PREFIX)) {
    const stripped = stripOwnMarkers(luaNext);
    luaNext = stripped.text;
    migrated = stripped.stripped;
    changedConfig = migrated > 0;
  }
  const need = requireLineFor(sidecarFile);
  const hasRequire = luaNext.split("\n").some((l) => l.trim() === need);
  const imported = importStaticRules(luaNext);
  const liveEntries = [...tileHorizontally(enabled).map(liveEntry), ...disabled.map(disabledEntry)];
  const preserved = imported.rules.filter((r) => !live.some((m) => monitorMatchesOutput(m, r.output)));
  const entries = [...liveEntries, ...preserved];
  if (!entries.some((e) => e.output === "")) {
    entries.push({ output: "", text: `hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })` });
  }

  const sidecar = join(dir, sidecarFile);
  const sidecarExisted = await fs.access(sidecar).then(() => true, () => false);
  await fs.writeFile(sidecar, renderSidecar(entries));
  if (!hasRequire) {
    luaNext = `${luaNext.replace(/\s*$/, "")}\n\n${TAKEOVER_COMMENT}\n${need}\n`;
    await fs.writeFile(luaPath, luaNext, "utf8");
    changedConfig = true;
    try {
      await verifyLiveSet(new Set(enabled.map((m) => m.name)));
    } catch (e) {
      const rolledBack = luaNext
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return t !== need && t !== TAKEOVER_COMMENT;
        })
        .join("\n");
      await fs.writeFile(luaPath, rolledBack, "utf8");
      if (!sidecarExisted) {
        try {
          await fs.unlink(sidecar);
        } catch {
          // already gone
        }
      }
      throw e;
    }
  } else if (changedConfig) {
    await fs.writeFile(luaPath, luaNext, "utf8");
  }
  return { sidecar, changedConfig, persisted: true, imported: imported.rules.length, skipped: imported.skipped, migrated };
}

export async function removeExtensionConfig(sidecarFile = SIDECAR_DEFAULT): Promise<void> {
  const dir = hyprDir();
  const luaPath = join(dir, "hyprland.lua");
  const need = requireLineFor(sidecarFile);
  const current = await fs.readFile(luaPath, "utf8").catch(() => {
    throw new Error("hyprland.lua not found");
  });
  const kept = current.split("\n").filter((l) => {
    const t = l.trim();
    return t !== need && t !== TAKEOVER_COMMENT;
  });
  if (kept.length !== current.split("\n").length) {
    await fs.writeFile(luaPath, kept.join("\n"), "utf8");
  }
  try {
    await fs.unlink(join(dir, sidecarFile));
  } catch {
    // already gone
  }
  const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith("hyprland.lua.vicinae-bak-"));
  for (const f of leftovers) {
    try {
      await fs.unlink(join(dir, f));
    } catch {
      // already gone
    }
  }
}

export function withRepositioned(placements: PlacedMonitor[], name: string, x: number, y: number): PlacedMonitor[] {
  return placements.map((p) => (p.monitor.name === name ? { ...p, x, y } : p));
}

export function parseCoordinate(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isInteger(n) || Math.abs(n) > 30000) return null;
  return n;
}
