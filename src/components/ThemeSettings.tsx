"use client";

import { Combobox } from "./Combobox";
import { Slider } from "./ui/slider";
import { Field } from "./ui";
import { useStore } from "@/lib/store";
import { ACCENTS, CODE_FONTS, UI_FONTS, type ThemeMode } from "@/lib/theme";

const MODES: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
];

export function ThemeSettings() {
  const { theme, setTheme } = useStore();

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Appearance</h2>
        <p className="text-xs text-muted-foreground">Applied straight away and remembered.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Color scheme">
          <Combobox
            value={theme.mode}
            onChange={(mode) => setTheme({ ...theme, mode: mode as ThemeMode })}
            options={MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
            searchPlaceholder="Find a scheme…"
          />
        </Field>

        <Field label="Accent">
          <div className="flex h-[34px] items-center gap-2">
            {ACCENTS.map((accent) => (
              <button
                key={accent.name}
                type="button"
                aria-label={accent.name}
                aria-pressed={theme.accent === accent.name}
                onClick={() => setTheme({ ...theme, accent: accent.name })}
                style={{ background: theme.mode === "light" ? accent.light : accent.dark }}
                className={`h-5 w-5 rounded-full transition ${
                  theme.accent === accent.name
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                    : ""
                }`}
              />
            ))}
          </div>
        </Field>

        <Field label="Interface font">
          <Combobox
            value={theme.uiFont}
            onChange={(uiFont) => setTheme({ ...theme, uiFont })}
            options={UI_FONTS.map((font) => ({ value: font.name, label: font.name }))}
            searchPlaceholder="Find a font…"
          />
        </Field>

        <Field label="Terminal font">
          <Combobox
            value={theme.codeFont}
            onChange={(codeFont) => setTheme({ ...theme, codeFont })}
            options={CODE_FONTS.map((font) => ({ value: font.name, label: font.name }))}
            searchPlaceholder="Find a font…"
          />
        </Field>

        <Field label={`Text size — ${theme.fontSize}px`}>
          <Slider
            min={13}
            max={20}
            value={[theme.fontSize]}
            onValueChange={(next) =>
              setTheme({ ...theme, fontSize: Array.isArray(next) ? next[0] : next })
            }
            className="w-full py-1.5"
          />
        </Field>

        <Field label={`Corner radius — ${theme.radius}px`}>
          <Slider
            min={0}
            max={16}
            value={[theme.radius]}
            onValueChange={(next) =>
              setTheme({ ...theme, radius: Array.isArray(next) ? next[0] : next })
            }
            className="w-full py-1.5"
          />
        </Field>
      </div>
    </section>
  );
}
