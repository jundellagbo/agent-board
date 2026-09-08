export type ThemeMode = "light" | "dark" | "system";

export interface Theme {
  mode: ThemeMode;
  accent: string;
  uiFont: string;
  codeFont: string;
  radius: number;
  fontSize: number;
}

export const ACCENTS: { name: string; light: string; dark: string }[] = [
  { name: "Blue", light: "oklch(0.58 0.16 258)", dark: "oklch(0.68 0.14 258)" },
  { name: "Violet", light: "oklch(0.55 0.19 300)", dark: "oklch(0.68 0.15 300)" },
  { name: "Green", light: "oklch(0.55 0.14 150)", dark: "oklch(0.72 0.14 150)" },
  { name: "Amber", light: "oklch(0.62 0.15 70)", dark: "oklch(0.78 0.14 75)" },
  { name: "Rose", light: "oklch(0.58 0.19 15)", dark: "oklch(0.70 0.16 15)" },
];

// Stacks, not webfonts: the app has to look right offline and on first paint.
export const UI_FONTS: { name: string; stack: string }[] = [
  { name: "Geist", stack: "var(--font-geist-sans), system-ui, sans-serif" },
  { name: "System", stack: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  { name: "Serif", stack: "ui-serif, Georgia, serif" },
];

export const CODE_FONTS: { name: string; stack: string }[] = [
  { name: "Geist Mono", stack: "var(--font-geist-mono), ui-monospace, monospace" },
  { name: "System Mono", stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
];

export const DEFAULT_THEME: Theme = {
  mode: "dark",
  accent: ACCENTS[0].name,
  uiFont: UI_FONTS[0].name,
  codeFont: CODE_FONTS[0].name,
  radius: 4,
  fontSize: 18,
};

export const THEME_KEY = "theme";

export function parseTheme(raw: string | undefined): Theme {
  if (!raw) return DEFAULT_THEME;
  try {
    // Unknown or removed keys fall back rather than throwing: a settings row
    // written by an older build must never leave the app unstyled.
    return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<Theme>) };
  } catch {
    return DEFAULT_THEME;
  }
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const dark = theme.mode === "dark" || (theme.mode === "system" && prefersDark());
  root.dataset.theme = dark ? "dark" : "light";

  const accent = ACCENTS.find((option) => option.name === theme.accent) ?? ACCENTS[0];
  root.style.setProperty("--brand", dark ? accent.dark : accent.light);
  root.style.setProperty("--brand-contrast", dark ? "oklch(0.18 0.01 260)" : "oklch(0.99 0 0)");

  const ui = UI_FONTS.find((option) => option.name === theme.uiFont) ?? UI_FONTS[0];
  const code = CODE_FONTS.find((option) => option.name === theme.codeFont) ?? CODE_FONTS[0];
  root.style.setProperty("--font-ui", ui.stack);
  root.style.setProperty("--font-code", code.stack);
  root.style.setProperty("--radius", `${theme.radius}px`);
  root.style.fontSize = `${theme.fontSize}px`;
}
