"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "./ui";
import { planner as plannerApi } from "@/lib/ipc";

type Layout = "edit" | "split" | "preview";

const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "split", label: "Split" },
  { id: "preview", label: "Preview" },
];

const AUTOSAVE_MS = 600;

// Drawn from the app's own tokens, so the editor follows light/dark and the
// chosen code font without a second theme to keep in step.
const surface = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-code)", fontSize: "0.8125rem", lineHeight: "1.6" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--brand) 25%, transparent)",
  },
});

const EXTENSIONS = [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
  surface,
];

export function PlanEditor({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("split");
  const [fullScreen, setFullScreen] = useState(false);
  const [status, setStatus] = useState<"saved" | "pending" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ name: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const edit = pending.current;
    if (!edit) return;
    pending.current = null;
    try {
      await plannerApi.write(edit.name, edit.text);
      setStatus("saved");
      onSaved();
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    let current = true;
    setText(null);
    setError(null);
    plannerApi
      .read(name)
      .then((contents) => current && setText(contents))
      .catch((cause) => current && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      current = false;
      // Switching notes mid-debounce must still land the last keystrokes.
      void flush();
    };
    // flush only reads refs, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!fullScreen) return;
    const leave = (event: KeyboardEvent) => event.key === "Escape" && setFullScreen(false);
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [fullScreen]);

  function change(value: string) {
    setText(value);
    setStatus("pending");
    pending.current = { name, text: value };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden border border-border bg-card ${
        fullScreen ? "fixed inset-0 z-50 rounded-none" : "flex-1 rounded-lg"
      }`}
    >
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-xs">{name}</p>
        <span
          className={`text-xs ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status === "pending" ? "Saving…" : status === "error" ? "Not saved" : "Saved"}
        </span>
        <nav className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {LAYOUTS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={layout === item.id}
              onClick={() => setLayout(item.id)}
              className={`rounded-[calc(var(--radius)-2px)] px-2.5 py-0.5 text-xs transition-colors ${
                layout === item.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <Button
          size="icon-xs"
          variant="ghost"
          title={fullScreen ? "Exit full screen (Esc)" : "Full screen"}
          onClick={() => setFullScreen((value) => !value)}
        >
          {fullScreen ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
      </header>

      {error && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {text === null ? (
        <p className="p-4 text-sm text-muted-foreground">{error ? "" : "Loading…"}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          {layout !== "preview" && (
            <div className={`min-h-0 min-w-0 flex-1 ${layout === "split" ? "border-r border-border" : ""}`}>
              <CodeMirror
                value={text}
                onChange={change}
                onBlur={() => void flush()}
                extensions={EXTENSIONS}
                theme="none"
                height="100%"
                className="h-full"
                autoFocus
              />
            </div>
          )}
          {layout !== "edit" && (
            <article className="markdown-body min-h-0 min-w-0 flex-1 overflow-y-auto px-8 py-6">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
