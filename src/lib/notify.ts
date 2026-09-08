import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { notify as notifyApi, settings as settingsApi } from "./ipc.ts";
import type { Task } from "./types";

export interface Webhook {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface NotificationConfig {
  desktop: boolean;
  /** Only failures, or every finished card. */
  onlyFailures: boolean;
  /** An agent stopping to ask is the one thing you cannot discover late. */
  approvals: boolean;
  webhooks: Webhook[];
}

export const NOTIFICATIONS_KEY = "notifications";

export const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  desktop: true,
  onlyFailures: false,
  approvals: true,
  webhooks: [],
};

export function parseNotifications(raw: string | undefined): NotificationConfig {
  if (!raw) return DEFAULT_NOTIFICATIONS;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationConfig>;
    return {
      ...DEFAULT_NOTIFICATIONS,
      ...parsed,
      webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : [],
    };
  } catch {
    return DEFAULT_NOTIFICATIONS;
  }
}

export function saveNotifications(config: NotificationConfig): Promise<void> {
  return settingsApi.set(NOTIFICATIONS_KEY, JSON.stringify(config));
}

export function completionMessage(task: Task, project: string, exitCode: number): string {
  const outcome = exitCode === 0 ? "finished" : `failed (exit ${exitCode})`;
  return `${project}: “${task.title}” ${outcome}`;
}

export function approvalMessage(task: Task, project: string): string {
  return `${project}: “${task.title}” is waiting for you`;
}

async function desktop(title: string, body: string): Promise<void> {
  // Asking on first use rather than at startup: a permission prompt before the
  // user has done anything is the fastest way to get denied.
  const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

/** Sends wherever the config says, and reports nothing back — a notification
 *  that fails to send must never interrupt the run it is describing. */
async function announce(
  config: NotificationConfig,
  title: string,
  text: string,
): Promise<void> {
  if (config.desktop) {
    await desktop(title, text).catch(() => undefined);
  }

  const targets = config.webhooks
    .filter((hook) => hook.enabled && hook.url.trim() !== "")
    .map((hook) => ({ name: hook.name, url: hook.url }));
  if (targets.length > 0) {
    await notifyApi.post(targets, text).catch(() => undefined);
  }
}

export async function announceApproval(
  config: NotificationConfig,
  task: Task,
  project: string,
): Promise<void> {
  // `onlyFailures` is about finished cards; an agent blocked on a question is
  // not a result, and silencing it would defeat the point of the setting.
  if (!config.approvals) return;
  await announce(config, "Agent Board — needs you", approvalMessage(task, project));
}

export async function announceCompletion(
  config: NotificationConfig,
  task: Task,
  project: string,
  exitCode: number,
): Promise<void> {
  if (config.onlyFailures && exitCode === 0) return;
  await announce(config, "Agent Board", completionMessage(task, project, exitCode));
}
