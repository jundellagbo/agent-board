"use client";

import { useState } from "react";

import { Button, CheckField, Checkbox, Input } from "./ui";
import { notify as notifyApi } from "@/lib/ipc";
import { useStore } from "@/lib/store";
import type { Webhook } from "@/lib/notify";

function blank(): Webhook {
  return { id: crypto.randomUUID(), name: "Team room", url: "", enabled: true };
}

export function NotificationSettings() {
  const { notifications, setNotifications } = useStore();
  const [status, setStatus] = useState<string | null>(null);

  function updateWebhook(id: string, patch: Partial<Webhook>) {
    setNotifications({
      ...notifications,
      webhooks: notifications.webhooks.map((hook) =>
        hook.id === id ? { ...hook, ...patch } : hook,
      ),
    });
  }

  async function test(hook: Webhook) {
    setStatus(`Sending to ${hook.name}…`);
    const results = await notifyApi
      .post([{ name: hook.name, url: hook.url }], "Agent Board test message")
      .catch(() => null);
    const result = results?.[0];
    setStatus(
      result?.ok ? `${hook.name}: delivered` : `${hook.name}: ${result?.message ?? "failed"}`,
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="text-xs text-muted-foreground">
          Told when a card finishes or an agent stops to ask you something. Webhooks are Google
          Workspace incoming webhooks — add as many rooms as you like.
        </p>
      </div>

      <CheckField
          label="Desktop notification when a card finishes"
          checked={notifications.desktop}
          onChange={(checked) => setNotifications({ ...notifications, desktop: checked })}
        />

      <CheckField
          label="Only tell me about failures"
          checked={notifications.onlyFailures}
          onChange={(checked) => setNotifications({ ...notifications, onlyFailures: checked })}
        />

      <div className="space-y-2">
        {notifications.webhooks.map((hook) => (
          <div
            key={hook.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-card p-2"
          >
            <Checkbox
              checked={hook.enabled}
              aria-label={`${hook.name} enabled`}
              onCheckedChange={(enabled) => updateWebhook(hook.id, { enabled })}
            />
            <Input className="w-40"
              value={hook.name}
              onChange={(event) => updateWebhook(hook.id, { name: event.target.value })}
              placeholder="Room name"
            />
            <Input className="flex-1 font-mono text-xs"
              value={hook.url}
              onChange={(event) => updateWebhook(hook.id, { url: event.target.value })}
              placeholder="https://chat.googleapis.com/v1/spaces/…"
            />
            <Button size="sm" variant="outline" disabled={hook.url.trim() === ""} onClick={() => void test(hook)}>
              Test
            </Button>
            <Button size="sm"
              variant="destructive"
              onClick={() =>
                setNotifications({
                  ...notifications,
                  webhooks: notifications.webhooks.filter((other) => other.id !== hook.id),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}

        <Button size="sm" variant="outline"
          onClick={() =>
            setNotifications({ ...notifications, webhooks: [...notifications.webhooks, blank()] })
          }
        >
          Add webhook
        </Button>
      </div>

      {status && <p className="text-xs text-muted-foreground">{status}</p>}
    </section>
  );
}
