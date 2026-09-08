"use client";

import { useState } from "react";

import { Combobox } from "./Combobox";
import { modelsFor } from "@/lib/models";
import { Button, CheckField, Field, Input, Modal, Textarea } from "./ui";
import type { Agent, BoardGroup, BoardType, GroupPatch } from "@/lib/types";

const BOARD_TYPES: { value: BoardType; label: string; hint: string }[] = [
  { value: "todo", label: "Todo", hint: "Queue the runner claims cards from" },
  { value: "in_progress", label: "In Progress", hint: "Where a card sits while its agent runs" },
  { value: "review", label: "Review", hint: "Finished, waiting on a human" },
  { value: "done", label: "Done", hint: "Closed out" },
  { value: "custom", label: "Custom", hint: "Anything else — testing, design, blocked" },
];

const COLORS = [
  "oklch(0.68 0.14 258)",
  "oklch(0.72 0.15 150)",
  "oklch(0.78 0.15 85)",
  "oklch(0.68 0.17 25)",
  "oklch(0.68 0.15 320)",
];

export function GroupDialog({
  group,
  groups,
  agents,
  onSave,
  onDelete,
  onClose,
}: {
  group?: BoardGroup;
  groups: BoardGroup[];
  agents: Agent[];
  onSave: (patch: GroupPatch) => void;
  onDelete?: (moveTasksTo?: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [boardType, setBoardType] = useState<BoardType>(group?.boardType ?? "custom");
  const [color, setColor] = useState(group?.color ?? "");
  const [autoRun, setAutoRun] = useState(group?.autoRun ?? false);
  const [plans, setPlans] = useState(group?.plans ?? false);
  const [skills, setSkills] = useState((group?.skills ?? []).join(", "));
  const [agentId, setAgentId] = useState(group?.agentId ?? "");
  const [model, setModel] = useState(group?.model ?? "");
  const [command, setCommand] = useState(group?.command ?? "");
  const [prompt, setPrompt] = useState(group?.prompt ?? "");
  const [wipLimit, setWipLimit] = useState(group?.wipLimit?.toString() ?? "");
  const [runningGroupId, setRunningGroupId] = useState(group?.runningGroupId ?? "");
  const [successGroupId, setSuccessGroupId] = useState(group?.successGroupId ?? "");
  const [failureGroupId, setFailureGroupId] = useState(group?.failureGroupId ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const others = groups.filter((candidate) => candidate.id !== group?.id);
  const chosenAgent =
    agents.find((agent) => agent.id === agentId) ?? agents.find((a) => a.isDefault);
  const hint = BOARD_TYPES.find((type) => type.value === boardType)?.hint;

  function submit() {
    onSave({
      name,
      boardType,
      color,
      autoRun,
      plans,
      // A blank field is a cleared field: the Rust patch turns "" back into NULL.
      skills: skills
        .split(",")
        .map((skill) => skill.trim())
        .filter(Boolean),
      agentId,
      model,
      command,
      prompt,
      wipLimit: wipLimit.trim() === "" ? null : Number(wipLimit),
      runningGroupId,
      successGroupId,
      failureGroupId,
    });
    onClose();
  }

  return (
    <Modal
      title={group ? `Edit ${group.name}` : "New column"}
      onClose={onClose}
      width="sm:max-w-md"
    >
      <form
        className="scroll-pane -mx-1.5 max-h-[70vh] space-y-3 overflow-y-auto py-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Testing"
          />
        </Field>

        <Field label="Board type">
          <Combobox
            value={boardType}
            onChange={(next) => setBoardType(next as BoardType)}
            options={BOARD_TYPES.map((type) => ({
              value: type.value,
              label: type.label,
              hint: type.hint,
            }))}
            searchPlaceholder="Find a board type…"
          />
        </Field>
        {hint && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}

        <Field label="Skills">
          <Input
            className="font-mono text-xs"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder="infra-llm-review, security-review"
          />
        </Field>

        <Field label="Agent">
          <Combobox
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: "", label: "Use the project's agent" },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
                hint: agent.command,
              })),
            ]}
            searchPlaceholder="Find an agent…"
          />
        </Field>

        <Field label="Model">
          <Combobox
            value={model}
            onChange={setModel}
            allowCustom
            options={[
              {
                value: "",
                label: chosenAgent?.model
                  ? `${chosenAgent.model} (the agent's)`
                  : "The agent's model",
              },
              ...modelsFor(chosenAgent?.command ?? "").map((option) => ({
                value: option.id,
                label: option.id,
                hint: option.label,
              })),
            ]}
            searchPlaceholder="Find or type a model…"
          />
        </Field>

        <Field label="Command">
          <Input
            className="font-mono text-xs"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="claude -p {prompt}"
          />
        </Field>

        <Field label="Prompt">
          <Textarea
            rows={2}
            className="resize-none"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What the agent should do with cards in this column"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="WIP limit">
            <Input
              type="number"
              min={1}
              value={wipLimit}
              onChange={(event) => setWipLimit(event.target.value)}
              placeholder="none"
            />
          </Field>
          <Field label="Color">
            <div className="flex h-[34px] items-center gap-1.5">
              {COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-label={`Use color ${option}`}
                  onClick={() => setColor(color === option ? "" : option)}
                  style={{ background: option }}
                  className={`h-5 w-5 rounded-full transition ${
                    color === option
                      ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                      : ""
                  }`}
                />
              ))}
            </div>
          </Field>
        </div>

        <CheckField
          label="Run cards that land here automatically"
          checked={autoRun}
          onChange={(checked) => setAutoRun(checked)}
        />

        <CheckField
          label="Plan before working"
          hint="the agent decides if the card needs one"
          checked={plans}
          onChange={(checked) => setPlans(checked)}
        />

        <fieldset className="space-y-2 rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Where cards go
          </legend>
          {(
            [
              ["While running", runningGroupId, setRunningGroupId],
              ["On success", successGroupId, setSuccessGroupId],
              ["On failure", failureGroupId, setFailureGroupId],
            ] as const
          ).map(([label, value, set]) => (
            <div key={label} className="grid grid-cols-[7rem_1fr] items-center gap-2 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <Combobox
                value={value}
                onChange={set}
                options={[
                  { value: "", label: "Stay put" },
                  ...others.map((candidate) => ({ value: candidate.id, label: candidate.name })),
                ]}
                searchPlaceholder="Find a column…"
              />
            </div>
          ))}
        </fieldset>

        <div className="flex items-center justify-between gap-2 pt-1">
          {onDelete ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                // Cards can't be orphaned: they follow to the first other column.
                onDelete(others[0]?.id);
                onClose();
              }}
            >
              {confirmDelete ? "Delete and move cards?" : "Delete"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" type="submit" variant="default" disabled={name.trim() === ""}>
              {group ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
