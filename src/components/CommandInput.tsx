"use client";

import { useId, useState, type ComponentProps, type KeyboardEvent } from "react";

import { Textarea } from "./ui";
import { commandName, commandQuery, suggestCommands } from "@/lib/compose";
import type { SlashCommand } from "@/lib/types";

/**
 * A card's text box that completes slash commands: typing "/infra" lists the
 * matching commands, arrows move through them, Tab or Enter takes one, and the
 * rest of the highlighted name (or a chosen command's argument hint) is drawn
 * as ghost text where it would go.
 */
export function CommandInput({
  value,
  onValueChange,
  commands,
  onKeyDown,
  className,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  commands: SlashCommand[];
}) {
  const listId = useId();
  const [highlight, setHighlight] = useState(0);
  // Escape hides the list for the text as it stands; typing brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);

  const query = commandQuery(value);
  const suggestions = query && dismissed !== value ? suggestCommands(commands, query) : [];
  const open = suggestions.length > 0;
  const active = open ? suggestions[Math.min(highlight, suggestions.length - 1)] : undefined;

  const chosen = commandName(value);
  const hint =
    chosen && value.trimEnd() === chosen
      ? commands.find((command) => command.name === chosen)?.argumentHint
      : null;
  const ghost = active?.name.startsWith(value)
    ? active.name.slice(value.length)
    : hint
      ? `${value.endsWith(" ") ? "" : " "}${hint}`
      : "";

  function accept(command: SlashCommand) {
    onValueChange(`${command.name} `);
    setHighlight(0);
  }

  function handleKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && active) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        setHighlight((current) => (current + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        accept(active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(value);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className="relative">
      <Textarea
        {...props}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={handleKey}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active ? `${listId}-${active.name}` : undefined}
        className={className}
      />
      {ghost && (
        // Same box and type as the textarea, typed text invisible, so the
        // completion lands exactly where the next characters would.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent px-2.5 py-2 text-base break-words whitespace-pre-wrap md:text-sm"
        >
          <span className="invisible">{value}</span>
          <span className="text-muted-foreground/60">{ghost}</span>
        </div>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((command) => (
            <li
              key={command.name}
              id={`${listId}-${command.name}`}
              role="option"
              aria-selected={command === active}
              // mousedown, not click: a click would blur the textarea first,
              // and the composer treats an empty blur as a cancel.
              onMouseDown={(event) => {
                event.preventDefault();
                accept(command);
              }}
              onMouseEnter={() => setHighlight(suggestions.indexOf(command))}
              className={`cursor-pointer rounded-md px-2 py-1 ${
                command === active ? "bg-muted" : ""
              }`}
            >
              <span className="block truncate font-mono text-xs">
                {command.name}
                {command.argumentHint && (
                  <span className="text-muted-foreground"> {command.argumentHint}</span>
                )}
              </span>
              {command.description && (
                <span className="block truncate text-[0.6875rem] text-muted-foreground">
                  {command.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
