// 📖 Docs: obsidian/frontend/components/scene.md
"use client";

/**
 * Control panel for the grass-field scene.
 *
 * Edits go straight to the live uniforms — no rebuild, no shader recompile, no
 * regenerating 420,000 blades — so dragging a swatch or a slider changes the
 * frame immediately. That is also the panel's boundary: everything here must be
 * a uniform (or a transform). Anything needing the field rebuilt does not belong.
 *
 * Deliberately hand-rolled rather than `lil-gui` or `leva`: it is colour inputs
 * and range inputs, and a dependency would cost more than it saves while
 * bringing its own styling that ignores the project's tokens.
 */

import { useState } from "react";

import type {
  SceneColorControl,
  SceneNumberControl,
} from "./create-grass-scene";

export interface SceneControlsProps {
  controls: SceneColorControl[];
  numbers: SceneNumberControl[];
  onColorChange: (key: string, hex: string) => void;
  onNumberChange: (key: string, value: number) => void;
  /** Starts collapsed; the scene is the point, not the panel. */
  defaultOpen?: boolean;
}

/**
 * Builds a snippet that can be pasted back into `grass-field.config.ts`.
 *
 * Every control knows its dotted path in the config, so the flat list is folded
 * back into the nested shape it came from. Emitting the panel's own keys instead
 * would mean hand-translating three dozen of them at the other end.
 */
const toConfigSnippet = (
  entries: Array<{ path: string; value: string | number }>,
): string => {
  type Tree = { [key: string]: Tree | string | number };
  const root: Tree = {};

  for (const entry of entries) {
    const segments = entry.path.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      node = typeof next === "object" ? next : (node[segment] = {});
    }
    node[segments[segments.length - 1]] = entry.value;
  }

  const render = (node: Tree, depth: number): string => {
    const pad = "  ".repeat(depth + 1);
    return Object.entries(node)
      .map(([key, value]) => {
        if (typeof value === "string") return pad + key + ': "' + value + '",';
        if (typeof value === "number") return pad + key + ": " + value + ",";
        return (
          pad + key + ": {\n" + render(value, depth + 1) + "\n" + pad + "},"
        );
      })
      .join("\n");
  };

  return "// grass-field.config.ts\n" + render(root, -1);
};

const BUTTON_CLASS =
  "rounded-md border border-foreground/15 px-2 py-1.5 text-xs transition-colors duration-[var(--duration-fast)] ease-entrance hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-40";

const RESET_CLASS =
  "shrink-0 rounded border border-foreground/15 px-1.5 py-0.5 text-[0.65rem] leading-none transition-colors duration-[var(--duration-fast)] ease-entrance hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-25";

export function SceneControls({
  controls,
  numbers,
  onColorChange,
  onNumberChange,
  defaultOpen = false,
}: SceneControlsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  /** Set when the clipboard refuses, so the snippet can be copied by hand. */
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [colorValues, setColorValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(controls.map((control) => [control.key, control.value])),
  );
  const [numberValues, setNumberValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(numbers.map((control) => [control.key, control.value])),
  );

  if (controls.length === 0 && numbers.length === 0) return null;

  // Colours and scalars share a group heading, so a group's swatches and its
  // sliders sit together instead of in two disconnected halves of the panel.
  const groupNames = [
    ...new Set([
      ...controls.map((control) => control.group),
      ...numbers.map((control) => control.group),
    ]),
  ];

  const applyColor = (key: string, hex: string) => {
    setColorValues((previous) => ({ ...previous, [key]: hex }));
    onColorChange(key, hex);
  };

  const applyNumber = (key: string, value: number) => {
    setNumberValues((previous) => ({ ...previous, [key]: value }));
    onNumberChange(key, value);
  };

  const resetAll = () => {
    for (const control of controls) onColorChange(control.key, control.value);
    for (const control of numbers) onNumberChange(control.key, control.value);
    setColorValues(Object.fromEntries(controls.map((c) => [c.key, c.value])));
    setNumberValues(Object.fromEntries(numbers.map((n) => [n.key, n.value])));
  };

  /**
   * Copies via the async Clipboard API, falling back to `execCommand`, and
   * showing the text if both refuse.
   *
   * Not belt-and-braces: `navigator.clipboard.writeText` rejects whenever the
   * document is not focused or the click was not a trusted gesture, and does not
   * exist at all on a non-secure origin — a panel opened on a phone over a LAN
   * IP hits the second. A button that silently does nothing is worse than a
   * textarea.
   */
  const copyConfig = async () => {
    const snippet = toConfigSnippet([
      ...controls.map((control) => ({
        path: control.path,
        value: colorValues[control.key] ?? control.value,
      })),
      ...numbers.map((control) => ({
        path: control.path,
        value: numberValues[control.key] ?? control.value,
      })),
    ]);

    let ok = false;
    try {
      await navigator.clipboard.writeText(snippet);
      ok = true;
    } catch {
      const scratch = document.createElement("textarea");
      scratch.value = snippet;
      scratch.setAttribute("readonly", "");
      scratch.className = "pointer-events-none fixed left-0 top-0 opacity-0";
      document.body.appendChild(scratch);
      scratch.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      scratch.remove();
    }

    if (ok) {
      setFallbackText(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      return;
    }
    setCopied(false);
    setFallbackText(snippet);
  };

  const changedCount =
    controls.filter((c) => (colorValues[c.key] ?? c.value) !== c.value).length +
    numbers.filter((n) => (numberValues[n.key] ?? n.value) !== n.value).length;

  return (
    <aside
      aria-label="Scene settings"
      className="absolute right-4 top-20 z-10 flex max-h-[calc(100%-6rem)] w-72 flex-col rounded-xl border border-foreground/10 bg-background/85 p-3 font-sans text-foreground shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Scene settings</h2>
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className={BUTTON_CLASS}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open && (
        <div className="mt-3 flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            {groupNames.map((group) => (
              <section key={group} aria-label={group}>
                <h3 className="mb-1.5 text-xs uppercase tracking-wide opacity-60">
                  {group}
                </h3>

                <ul className="flex flex-col gap-1.5">
                  {controls
                    .filter((control) => control.group === group)
                    .map((control) => {
                      const value = colorValues[control.key] ?? control.value;
                      const changed = value !== control.value;
                      return (
                        <li
                          key={control.key}
                          className="flex items-center gap-2"
                        >
                          <label
                            htmlFor={`scene-color-${control.key}`}
                            className="min-w-0 flex-1 truncate text-xs"
                            title={control.path}
                          >
                            {control.label}
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              applyColor(control.key, control.value)
                            }
                            disabled={!changed}
                            aria-label={`Reset ${control.label}`}
                            title={
                              changed
                                ? `Reset to ${control.value}`
                                : "Already default"
                            }
                            className={RESET_CLASS}
                          >
                            ↺
                          </button>
                          <input
                            id={`scene-color-${control.key}`}
                            type="color"
                            value={value}
                            onChange={(event) =>
                              applyColor(control.key, event.target.value)
                            }
                            className="h-6 w-10 shrink-0 cursor-pointer rounded border border-foreground/15 bg-transparent"
                          />
                        </li>
                      );
                    })}

                  {numbers
                    .filter((control) => control.group === group)
                    .map((control) => {
                      const value = numberValues[control.key] ?? control.value;
                      const changed = value !== control.value;
                      return (
                        <li key={control.key} className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor={`scene-number-${control.key}`}
                              className="min-w-0 flex-1 truncate text-xs"
                              title={control.path}
                            >
                              {control.label}
                            </label>
                            <span className="shrink-0 font-mono text-[0.65rem] opacity-70">
                              {value}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                applyNumber(control.key, control.value)
                              }
                              disabled={!changed}
                              aria-label={`Reset ${control.label}`}
                              title={
                                changed
                                  ? `Reset to ${control.value}`
                                  : "Already default"
                              }
                              className={RESET_CLASS}
                            >
                              ↺
                            </button>
                          </div>
                          <input
                            id={`scene-number-${control.key}`}
                            type="range"
                            min={control.min}
                            max={control.max}
                            step={control.step}
                            value={value}
                            onChange={(event) =>
                              applyNumber(
                                control.key,
                                Number(event.target.value),
                              )
                            }
                            className="w-full cursor-pointer accent-foreground/70"
                          />
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
          </div>

          <div className="flex gap-2 border-t border-foreground/10 pt-3">
            <button
              type="button"
              onClick={copyConfig}
              className={`flex-1 ${BUTTON_CLASS}`}
            >
              {copied ? "Copied" : "Copy config"}
            </button>
            <button
              type="button"
              onClick={resetAll}
              disabled={changedCount === 0}
              className={BUTTON_CLASS}
            >
              Reset all{changedCount > 0 ? ` (${changedCount})` : ""}
            </button>
          </div>

          {fallbackText !== null && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="scene-config-snippet"
                className="text-xs opacity-70"
              >
                Clipboard unavailable — select and copy:
              </label>
              <textarea
                id="scene-config-snippet"
                readOnly
                value={fallbackText}
                rows={8}
                onFocus={(event) => event.currentTarget.select()}
                className="w-full resize-none rounded-md border border-foreground/15 bg-background/60 p-2 font-mono text-[0.65rem] leading-snug"
              />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
