import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Action, ActionPanel, Alert, Color, Form, Icon, List, Toast, confirmAlert, getPreferenceValues, showToast, useNavigation } from "@vicinae/api";
import {
  SIDECAR_DEFAULT,
  applyPlacements,
  getAllMonitors,
  getConfigState,
  modeFor,
  moveId,
  orderLeftToRight,
  parseCoordinate,
  persistLiveLayout,
  removeExtensionConfig,
  scaledWidth,
  setEnabled,
  tileHorizontally,
  withRepositioned,
  type ConfigState,
  type HyprMonitor,
  type PlacedMonitor,
} from "./lib/hypr";

interface Prefs {
  "managed-file"?: string;
}

function prefs(): Prefs {
  try {
    return getPreferenceValues<Prefs>();
  } catch {
    return {};
  }
}

function managedFile(): string {
  return prefs()["managed-file"] || SIDECAR_DEFAULT;
}

function detailMarkdown(m: HyprMonitor, position: string, legacy: boolean): string {
  const warn = legacy ? "\n> ⚠️ Old hyprlang config. Runtime moves still apply, but persistence needs `hyprland.lua`.\n" : "";
  return `# ${m.name}\n\n**Position** \`${position}\` · **Mode** \`${modeFor(m)}\` · **Scale** \`${m.scale}\`${warn}`;
}

function EditPosition({
  monitor,
  x,
  y,
  onApply,
}: {
  monitor: HyprMonitor;
  x: number;
  y: number;
  onApply: (x: number, y: number) => Promise<void>;
}) {
  const { pop } = useNavigation();
  const [xError, setXError] = useState<string | undefined>();
  const [yError, setYError] = useState<string | undefined>();

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Position"
            onSubmit={async (values) => {
              const nx = parseCoordinate(values.x);
              const ny = parseCoordinate(values.y);
              setXError(nx === null ? "Integer pixels, e.g. 2560" : undefined);
              setYError(ny === null ? "Integer pixels, e.g. 0" : undefined);
              if (nx === null || ny === null) return;
              await onApply(nx, ny);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Display" text={`${monitor.name} — ${modeFor(monitor)}`} />
      <Form.TextField
        id="x"
        title="X position"
        defaultValue={String(x)}
        error={xError}
        onChange={(v) => setXError(parseCoordinate(v) === null ? "Integer pixels, e.g. 2560" : undefined)}
      />
      <Form.TextField
        id="y"
        title="Y position"
        defaultValue={String(y)}
        error={yError}
        onChange={(v) => setYError(parseCoordinate(v) === null ? "Integer pixels, e.g. 0" : undefined)}
      />
      <Form.Description title="Note" text="Applies instantly via hyprctl. Negative Y places above, like your vertical offsets." />
    </Form>
  );
}

export default function Command() {
  const [all, setAll] = useState<HyprMonitor[] | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const load = useCallback(async (announceLegacy: boolean, quiet = false) => {
    if (quiet && busyRef.current) return;
    try {
      const [monitors, cfg] = await Promise.all([getAllMonitors(), getConfigState()]);
      setError(null);
      setAll(monitors);
      setConfig(cfg);
      setOrder((prev) => {
        const enabled = monitors.filter((m) => !m.disabled).map((m) => m.name);
        const kept = prev.filter((n) => enabled.includes(n));
        const fresh = enabled.filter((n) => !kept.includes(n));
        if (kept.length > 0 || fresh.length !== enabled.length) return [...kept, ...fresh];
        return orderLeftToRight(monitors.filter((m) => !m.disabled)).map((m) => m.name);
      });
      if (announceLegacy && cfg.isLegacy) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Old hyprlang config detected",
          message: "Switch to hyprland.lua — hyprlang is deprecated since 0.55",
        });
      }
    } catch (e) {
      if (quiet) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(false, true), 2000);
    return () => clearInterval(t);
  }, [load]);

  const byName = useMemo(() => new Map((all ?? []).map((m) => [m.name, m])), [all]);
  const enabled = useMemo(() => order.map((n) => byName.get(n)).filter((m): m is HyprMonitor => Boolean(m)), [order, byName]);
  const disabled = useMemo(() => (all ?? []).filter((m) => m.disabled), [all]);
  const placements = useMemo(() => tileHorizontally(enabled), [enabled]);

  const guarded = useCallback(
    async (fn: () => Promise<void>, ok?: string, message?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        await load(false);
        if (ok) await showToast({ style: Toast.Style.Success, title: ok, message });
      } catch (e) {
        await showToast({ style: Toast.Style.Failure, title: "Hyprland call failed", message: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [busy, load],
  );

  const applyAndPersist = useCallback(
    async (placements: PlacedMonitor[], ok: string) => {
      if (!config) return;
      await applyPlacements(placements, config.provider);
      const r = await persistLiveLayout(managedFile());
      await showToast({
        style: Toast.Style.Success,
        title: ok,
        message: r.changedConfig ? "Config updated — layout persists across reboots" : undefined,
      });
    },
    [config],
  );

  const move = useCallback(
    (name: string, dir: -1 | 1) => {
      const next = moveId(order, name, dir);
      if (next.join() === order.join() || !config) return;
      const ordered = next.map((n) => byName.get(n)).filter((m): m is HyprMonitor => Boolean(m));
      const nextPlacements = tileHorizontally(ordered);
      void guarded(async () => {
        await applyAndPersist(nextPlacements, `Moved ${name} ${dir === -1 ? "left" : "right"}`);
        setOrder(next);
      });
    },
    [order, byName, config, guarded, applyAndPersist],
  );

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={{ source: Icon.Exclamationmark, tintColor: Color.Red }}
          title="Cannot reach Hyprland"
          description={`${error}\nRun inside Hyprland (HYPRLAND_INSTANCE_SIGNATURE must be set) with hyprctl on PATH.`}
        />
      </List>
    );
  }

  if (!all || !config) {
    return <List isLoading searchBarPlaceholder="Reading hyprctl displays…" />;
  }

  return (
    <List isLoading={busy} isShowingDetail searchBarPlaceholder="Displays — Ctrl+←/→ to reorder">
      {config.isLegacy ? (
        <List.Section title="Upgrade notice">
          <List.Item
            title="Old hyprlang config in use"
            subtitle="hyprland.conf — deprecated since 0.55"
            icon={{ source: Icon.Exclamationmark, tintColor: Color.Orange }}
            detail={
              <List.Item.Detail
                markdown={"# Upgrade to Lua\n\nThis machine still configures Hyprland with `hyprland.conf` (hyprlang), deprecated since 0.55 in favour of `hyprland.lua`.\n\n- Arrange actions below still work, but positions won't persist on hyprlang.\n- Migrate to `hyprland.lua` first for persistence.\n- Wiki: Hyprland “Lua-ification” news post, April 2026."}
              />
            }
            actions={
              <ActionPanel>
                <Action.OpenInBrowser title="Open Lua Migration News" url="https://hypr.land/news/26_lua" />
                <Action title="Reload" icon={Icon.ArrowClockwise} onAction={() => void load(false)} />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}

      <List.Section title={`Layout — ${placements.length} active`}>
        {placements.map((p) => {
          const m = p.monitor;
          const position = `${p.x}x${p.y}`;
          return (
            <List.Item
              key={m.name}
              title={m.name}
              subtitle={`${modeFor(m)} @ ${position}`}
              icon={{ source: m.focused ? Icon.Star : Icon.Desktop, tintColor: m.focused ? Color.Yellow : Color.Blue }}
              accessories={[
                { text: `scale ${m.scale}` },
                { text: `${scaledWidth(m)}px wide` },
                ...(m.focused ? [{ tag: { value: "focused", color: Color.Yellow } }] : []),
              ]}
              detail={
                <List.Item.Detail
                  markdown={detailMarkdown(m, position, config.isLegacy)}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="Output" text={m.name} />
                      <List.Item.Detail.Metadata.Label title="Description" text={m.description || "—"} />
                      <List.Item.Detail.Metadata.Label title="Serial" text={m.serial || "—"} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="Mode" text={modeFor(m)} />
                      <List.Item.Detail.Metadata.Label title="Position" text={position} />
                      <List.Item.Detail.Metadata.Label title="Scale" text={String(m.scale)} />
                      <List.Item.Detail.Metadata.Label title="DPMS" text={m.dpmsStatus ? "on" : "off"} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="Arrange">
                    <Action
                      title="Move Left"
                      icon={Icon.ArrowLeft}
                      shortcut={{ modifiers: ["ctrl"], key: "arrowLeft" }}
                      onAction={() => move(m.name, -1)}
                    />
                    <Action
                      title="Move Right"
                      icon={Icon.ArrowRight}
                      shortcut={{ modifiers: ["ctrl"], key: "arrowRight" }}
                      onAction={() => move(m.name, 1)}
                    />
                    <Action.Push
                      title="Edit Position…"
                      icon={Icon.Pencil}
                      shortcut={{ modifiers: ["cmd"], key: "e" }}
                      target={
                        <EditPosition
                          monitor={m}
                          x={p.x}
                          y={p.y}
                          onApply={(nx, ny) =>
                            guarded(() => applyAndPersist(withRepositioned(placements, m.name, nx, ny), `Moved ${m.name} to ${nx}x${ny}`))
                          }
                        />
                      }
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section title="Display">
                    <Action
                      title="Disable Display"
                      icon={Icon.EyeDisabled}
                      style="destructive"
                      onAction={() => {
                        if (enabled.length <= 1) {
                          void showToast({ style: Toast.Style.Failure, title: "Cannot disable the last active display" });
                          return;
                        }
                        void guarded(async () => {
                          await setEnabled(m, false, config.provider);
                          await persistLiveLayout(managedFile());
                          await showToast({ style: Toast.Style.Success, title: `Disabled ${m.name}` });
                        });
                      }}
                    />
                    <Action.CopyToClipboard title="Copy Position" content={position} />
                    <Action.ShowInFinder title="Reveal Hypr Config Folder" path={config.hyprDir} />
                    <Action
                      title="Remove Extension Config"
                      icon={Icon.Trash}
                      style="destructive"
                      onAction={() => {
                        void (async () => {
                          const ok = await confirmAlert({
                            title: "Remove extension config?",
                            message: `Deletes the ${managedFile()} sidecar, its require lines, and extension backups. Your static rules take over again on next reload.`,
                            primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
                          });
                          if (!ok) return;
                          await guarded(async () => {
                            await removeExtensionConfig(managedFile());
                            await showToast({ style: Toast.Style.Success, title: "Extension config removed" });
                          });
                        })();
                      }}
                    />
                    <Action title="Reload" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => void load(false)} />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>

      {disabled.length > 0 ? (
        <List.Section title={`Disabled — ${disabled.length}`}>
          {disabled.map((m) => (
            <List.Item
              key={m.name}
              title={m.name}
              subtitle={m.description || "disabled"}
              icon={{ source: Icon.EyeDisabled, tintColor: Color.SecondaryText }}
              detail={<List.Item.Detail markdown={`# ${m.name}\n\nDisabled. Enable to append it at the end of the strip, then reorder with Ctrl+Left / Ctrl+Right.`} />}
              actions={
                <ActionPanel>
                  <Action
                    title="Enable Display"
                    icon={Icon.Eye}
                    onAction={() =>
                      void guarded(async () => {
                        await setEnabled(m, true, config.provider);
                        await persistLiveLayout(managedFile());
                        await showToast({ style: Toast.Style.Success, title: `Enabled ${m.name}` });
                      })
                    }
                  />
                  <Action title="Reload" icon={Icon.ArrowClockwise} onAction={() => void load(false)} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
