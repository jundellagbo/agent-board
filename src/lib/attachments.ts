"use client";

import { useCallback, useEffect, useState } from "react";

import { tmp as tmpApi } from "./ipc";
import type { TmpFile, TmpKind } from "./types";

/** Reads a picked, dropped or pasted file as base64 for the IPC boundary. */
export function encode(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    // A data URL is "data:<mime>;base64,<payload>", and only the payload
    // crosses to Rust — the mime is read back from the name it is saved under.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

/**
 * An id for a card that does not exist yet.
 *
 * Anything attached while composing has to be filed somewhere, and the store is
 * keyed by card id — so the composer picks the id up front and hands it to
 * `create_task`, which means a path written into the card's text is still the
 * right path once the card is real.
 */
export function reserveCardId(): string {
  return crypto.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A name for something pasted from the clipboard, which arrives with none. */
export function pastedName(blob: Blob): string {
  const extension = blob.type.split("/")[1]?.split("+")[0] || "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}.${extension}`;
}

/**
 * A card's tmp files, kept in step with the directory rather than with our own
 * writes: an agent writing its response, or someone dropping a file in from the
 * file manager, has to show up here too. Pass no card to watch the whole store.
 */
export function useAttachments(cardId?: string | null) {
  const [files, setFiles] = useState<TmpFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await tmpApi.list(cardId ?? null));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [cardId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unlisten = tmpApi.onChanged((changed) => {
      if (!cardId || changed === cardId) void refresh();
    });
    return () => void unlisten.then((stop) => stop());
  }, [cardId, refresh]);

  // The watcher announces the write, so none of these re-read on their own.
  const attach = useCallback(
    async (blob: Blob, name: string, kind: TmpKind = "attached") => {
      if (!cardId) return null;
      try {
        return await tmpApi.add(cardId, kind, name, await encode(blob));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [cardId],
  );

  const screenshot = useCallback(async () => {
    if (!cardId) return null;
    try {
      const file = await tmpApi.screenshot(cardId);
      setError(null);
      return file;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [cardId]);

  /**
   * The clipboard's own image, when the paste event carried no file.
   *
   * Silent on failure, unlike the rest: this runs on every paste that looked
   * like it might be an image, and an ordinary text paste must not raise an
   * error under the composer.
   */
  const pasteFromClipboard = useCallback(async () => {
    if (!cardId) return null;
    try {
      return await tmpApi.paste(cardId);
    } catch {
      return null;
    }
  }, [cardId]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return {
    files,
    error,
    refresh,
    attach,
    screenshot,
    pasteFromClipboard,
    remove: (path: string) => act(() => tmpApi.remove(path)),
    reveal: (path: string) => act(() => tmpApi.reveal(path)),
    /** Everything one card collected — the store view manages cards, not files. */
    clear: (card: string) => act(() => tmpApi.clear(card)),
  };
}

/** The file itself, as something an <img> can show. */
export async function preview(file: TmpFile): Promise<string> {
  return `data:${file.mime};base64,${await tmpApi.read(file.path)}`;
}
