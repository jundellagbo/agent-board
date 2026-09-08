"use client";

import { useState } from "react";

import { Button, Field, Input, Modal } from "./ui";
import { orgs as orgApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Organization } from "@/lib/types";

export function OrgDialog({ org, onClose }: { org?: Organization; onClose: () => void }) {
  const { run, selectOrg } = useStore();
  const [name, setName] = useState(org?.name ?? "");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const saved = org
      ? await run(() => orgApi.rename(org.id, name))
      : await run(() => orgApi.create(name));
    setBusy(false);
    if (!saved) return;
    if (!org) selectOrg(saved.id);
    onClose();
  }

  return (
    <Modal title={org ? "Rename organization" : "New organization"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" type="submit" variant="default" disabled={busy || name.trim() === ""}>
            {org ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
