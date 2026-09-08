"use client";

import { useStore, type View } from "@/lib/store";

const VIEWS: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "terminal", label: "Terminal" },
  { id: "settings", label: "Settings" },
];

export function Header() {
  const { project, view, setView } = useStore();

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{project?.name ?? "Agent Board"}</h1>
        {project && (
          <p className="truncate font-mono text-xs text-muted-foreground">{project.path}</p>
        )}
      </div>

      <nav className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            aria-pressed={view === item.id}
            className={`rounded-[calc(var(--radius)-2px)] px-3 py-1 text-xs transition-colors ${
              view === item.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
