"use client";

import type { ReactNode } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";

export { Button } from "./ui/button";
export { Checkbox };
export { Input } from "./ui/input";
export { Textarea } from "./ui/textarea";

/** A labelled control. The label wraps its input, so the association is implicit. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <Label className="flex w-full flex-col gap-1.5 font-normal">
      <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Label>
  );
}

/** A checkbox with its own label — the pattern every settings row uses. */
export function CheckField({
  label,
  checked,
  onChange,
  disabled,
  hint,
  compact,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
  /** Sized for the card composer, where every other control is xs. */
  compact?: boolean;
}) {
  return (
    <Label
      className={
        compact
          ? "flex items-center gap-1.5 text-xs font-normal"
          : "flex items-center gap-2 font-normal"
      }
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className={compact ? "size-3.5" : undefined}
      />
      <span>{label}</span>
      {hint && (
        <span className={compact ? "text-muted-foreground" : "text-xs text-muted-foreground"}>
          {hint}
        </span>
      )}
    </Label>
  );
}

/**
 * An always-open dialog driven by the caller's own state. Escape, the backdrop,
 * the focus trap and the labelling all come from the primitive.
 */
export function Modal({
  title,
  onClose,
  children,
  width = "sm:max-w-sm",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={width}>
        <DialogHeader>
          {/* Dialog titles quote things people and agents named — a card title,
              a file — so the header has to survive a long one. */}
          <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
