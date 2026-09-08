"use client";

import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "cn";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A select you can type into. Every list in this app can grow past the point
 * where scanning a native dropdown works — twenty columns, a dozen models — so
 * the filter is always there rather than appearing at some arbitrary threshold.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled,
  className,
  allowCustom = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /** Accept something typed that is not in the list — a model id we don't know
   *  about is still a model the CLI might accept. */
  allowCustom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || options.length === 0}
            className={cn("w-full justify-between font-normal", className)}
          >
            <span className={cn("truncate", !selected && !value && "text-muted-foreground")}>
              {selected?.label ?? value ?? placeholder}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        }
      />

      <PopoverContent align="start" className="w-(--anchor-width) min-w-56 p-0">
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {allowCustom && query.trim() !== "" ? (
                <button
                  type="button"
                  onClick={() => choose(query.trim())}
                  className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                >
                  Use “{query.trim()}”
                </button>
              ) : (
                emptyText
              )}
            </CommandEmpty>
            <CommandGroup>
              {options.map((option, index) => (
                <CommandItem
                  // Lists here deliberately carry an empty-valued option for
                  // "use the default", so the position keeps keys unique.
                  key={`${index}:${option.value}`}
                  // cmdk filters on this, not on the value, so an id never
                  // stands in for the name the user is actually typing.
                  value={`${option.label} ${option.hint ?? ""}`}
                  onSelect={() => choose(option.value)}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{option.label}</span>
                    {option.hint && (
                      <span className="truncate text-xs text-muted-foreground">{option.hint}</span>
                    )}
                  </div>
                  {option.value === value && <CheckIcon className="size-4 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
