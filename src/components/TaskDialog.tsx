"use client";

import { useState } from "react";

import { AttachmentPicker } from "./Attachments";
import { Button, Field, Input, Modal, Textarea } from "./ui";
import { appendPath } from "@/lib/compose";
import type { Task } from "@/lib/types";

export interface TaskEdit {
  title: string;
  body: string;
  followUp: string;
}

export function TaskDialog({
  task,
  running,
  onSave,
  onClose,
}: {
  task: Task;
  /** Whether an agent is on this card right now, which decides where a
   *  follow-up goes: to the agent, or onto the card for its next run. */
  running: boolean;
  onSave: (edit: TaskEdit) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [followUp, setFollowUp] = useState("");

  return (
    <Modal title="Edit card" onClose={onClose} width="sm:max-w-lg">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ title, body, followUp });
          onClose();
        }}
      >
        <Field label="Title">
          <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <Field label="Detail">
          <Textarea
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="A numbered list becomes the card's checklist."
            className="resize-none"
          />
        </Field>

        <div className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Attachments
          </span>
          {/* The path goes into the detail as the file lands: the agent reads
              the card, not the directory. */}
          <AttachmentPicker
            cardId={task.id}
            onAttached={(file) => setBody((current) => appendPath(current, file.path))}
          />
        </div>

        <Field
          label="Follow-up"
          hint={
            running
              ? "Sent straight to the agent working on this card."
              : "Added to the card, for whoever picks it up next."
          }
        >
          <Textarea
            rows={2}
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="Something else it should do"
            className="resize-none"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={title.trim() === ""}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
