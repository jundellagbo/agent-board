"use client";

import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import { Button, Field, Input, Modal } from "./ui";
import { projects as projectApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

export function ProjectDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const { run, selectProject } = useStore();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [busy, setBusy] = useState(false);

  async function pick() {
    const picked = await open({ directory: true, multiple: false, title: "Choose project folder" });
    if (typeof picked !== "string") return;
    setPath(picked);
    // The folder name is nearly always the right project name, but stop guessing
    // the moment the user types their own.
    if (!touchedName) setName(basename(picked));
  }

  async function submit() {
    setBusy(true);
    const created = await run(() => projectApi.create(orgId, path, name || undefined));
    setBusy(false);
    if (!created) return;
    selectProject(created.id);
    onClose();
  }

  return (
    <Modal title="Add project" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Directory">
          <div className="flex gap-2">
            <Input className="font-mono text-xs"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/home/you/code/app"
            />
            <Button size="sm" variant="outline" onClick={() => void pick()}>Browse</Button>
          </div>
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => {
              setTouchedName(true);
              setName(event.target.value);
            }}
            placeholder={basename(path) || "app"}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" variant="default" disabled={busy || path.trim() === ""}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}
