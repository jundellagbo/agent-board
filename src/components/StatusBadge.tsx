"use client";

import {
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  HandIcon,
  LoaderCircleIcon,
  MapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { Badge } from "./ui/badge";
import type { RunState } from "@/lib/types";

// Colour carries the meaning at a glance; the icon and word are there because
// colour alone is not readable for everyone, and "amber" tells you nothing about
// what the agent is actually waiting for.
const STATES: Record<
  Exclude<RunState, "idle">,
  { label: string; className: string; icon: ComponentType<{ className?: string }>; spin?: boolean }
> = {
  queued: {
    label: "Queued",
    className: "bg-muted text-muted-foreground",
    icon: ClockIcon,
  },
  planning: {
    label: "Planning",
    className: "bg-primary/10 text-primary",
    icon: MapIcon,
  },
  running: {
    label: "Running",
    className: "bg-primary/15 text-primary",
    icon: LoaderCircleIcon,
    spin: true,
  },
  needs_approval: {
    label: "Needs you",
    className: "bg-warning/15 text-warning",
    icon: HandIcon,
  },
  blocked: {
    label: "Needs attention",
    className: "bg-warning/20 text-warning",
    icon: TriangleAlertIcon,
  },
  done: {
    label: "Done",
    className: "bg-success/15 text-success",
    icon: CheckIcon,
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/15 text-destructive",
    icon: CircleAlertIcon,
  },
};

export function StatusBadge({ state }: { state: RunState }) {
  if (state === "idle") return null;

  const { label, className, icon: Icon, spin } = STATES[state];
  return (
    <Badge variant="ghost" className={`gap-1 border-transparent px-1.5 ${className}`}>
      <Icon className={spin ? "animate-spin" : undefined} />
      {label}
    </Badge>
  );
}
