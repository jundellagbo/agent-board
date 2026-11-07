"use client";

import { CameraIcon, FileTextIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, Modal } from "./ui";
import { pastedName, preview, useAttachments } from "@/lib/attachments";
import type { TmpFile } from "@/lib/types";

/**
 * The file's own bytes, as something an `<img>` can show.
 *
 * The webview cannot read `file://`, so a thumbnail is the file read back
 * through Rust. Only images are worth fetching; everything else shows as a
 * named chip. Keyed on the path and the timestamp so a file rewritten under the
 * same name is re-read, and a re-listed one is not.
 */
function useImage(file: TmpFile | null): string | null {
  const [source, setSource] = useState<string | null>(null);
  const image = file?.mime.startsWith("image/") ?? false;
  const key = file && image ? `${file.path}:${file.modifiedAt}` : "";

  useEffect(() => {
    setSource(null);
    if (!key || !file) return;

    let wanted = true;
    void preview(file)
      .then((url) => wanted && setSource(url))
      .catch(() => undefined);
    return () => {
      wanted = false;
    };
    // The list is re-read whole, so every file is a new object each time; the
    // key is what actually says whether this is a different file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return source;
}

function extension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop()!.toUpperCase() : "FILE";
}

function Thumbnail({
  file,
  onOpen,
  onRemove,
}: {
  file: TmpFile;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const image = useImage(file);

  return (
    <div className="group/thumb relative shrink-0">
      <button
        type="button"
        title={`${file.name} — ${file.kind === "response" ? "from the agent" : "attached"}`}
        // The card is draggable and opens on click; a thumbnail inside it must
        // do neither.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className={`flex size-10 items-center justify-center overflow-hidden rounded border bg-muted transition-colors hover:border-ring ${
          // What came back from the agent is worth telling apart from what it
          // was given, without a second row of labels to say so.
          file.kind === "response" ? "border-primary/50" : "border-border"
        }`}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={file.name} className="size-full object-cover" />
        ) : (
          <span className="font-mono text-[0.5rem] text-muted-foreground">
            {extension(file.name)}
          </span>
        )}
      </button>

      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="absolute -top-1 -right-1 hidden rounded-full bg-card p-0.5 text-muted-foreground shadow-sm hover:text-destructive group-hover/thumb:block"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

/** A card's files, along one scrolling row. */
export function AttachmentStrip({
  files,
  onOpen,
  onRemove,
}: {
  files: TmpFile[];
  onOpen: (file: TmpFile) => void;
  onRemove?: (file: TmpFile) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div
      className="mt-1.5 flex gap-1 overflow-x-auto pb-1"
      // The strip scrolls; the column underneath it must not take the gesture.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {files.map((file) => (
        <Thumbnail
          key={file.path}
          file={file}
          onOpen={() => onOpen(file)}
          onRemove={onRemove && (() => onRemove(file))}
        />
      ))}
    </div>
  );
}

/** Everything a card is carrying, larger than the strip and with names. */
export function CardFilesDialog({
  title,
  files,
  onOpen,
  onRemove,
  onReveal,
  onClose,
}: {
  title: string;
  files: TmpFile[];
  onOpen: (file: TmpFile) => void;
  onRemove?: (file: TmpFile) => void;
  onReveal?: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`Files — ${title}`} onClose={onClose} width="sm:max-w-2xl">
      <div className="space-y-3">
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Files you attach, and screenshots or reports the agent mentions, land here.
          </p>
        ) : (
          <ul className="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 overflow-y-auto">
            {files.map((file) => (
              <li key={file.path} className="min-w-0">
                <FileTile
                  file={file}
                  onOpen={() => onOpen(file)}
                  onRemove={onRemove && (() => onRemove(file))}
                />
              </li>
            ))}
          </ul>
        )}
        {onReveal && files.length > 0 && (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={onReveal}>
              Show in file manager
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function FileTile({
  file,
  onOpen,
  onRemove,
}: {
  file: TmpFile;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const image = useImage(file);
  return (
    <div className="group/tile relative">
      <button
        type="button"
        onClick={onOpen}
        title={file.name}
        className={`flex w-full flex-col overflow-hidden rounded-md border text-left transition-colors hover:border-ring ${
          file.kind === "response" ? "border-primary/50" : "border-border"
        }`}
      >
        <span className="flex aspect-video items-center justify-center bg-muted">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="size-full object-cover" />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{extension(file.name)}</span>
          )}
        </span>
        <span className="truncate px-1.5 py-1 text-xs">{file.name}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${file.name}`}
          onClick={onRemove}
          className="absolute top-1 right-1 hidden rounded-full bg-card p-0.5 text-muted-foreground shadow-sm hover:text-destructive group-hover/tile:block"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One file, big enough to actually look at. */
export function AttachmentPreview({
  file,
  onClose,
  onRemove,
  onReveal,
}: {
  file: TmpFile;
  onClose: () => void;
  onRemove?: () => void;
  onReveal?: () => void;
}) {
  const image = useImage(file);

  return (
    <Modal title={file.name} onClose={onClose} width="sm:max-w-2xl">
      <div className="space-y-3">
        <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted p-2">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={file.name} className="max-h-[60vh] object-contain" />
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              {file.mime.startsWith("text/") ? (
                <FileTextIcon className="size-4" />
              ) : (
                <PaperclipIcon className="size-4" />
              )}
              Nothing to show here — open it in the file manager.
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">
            {file.kind === "response" ? "From the agent" : "Attached"} · {size(file.size)}
          </p>
          <div className="flex gap-2">
            {onReveal && (
              <Button size="sm" variant="outline" onClick={onReveal}>
                Show in file manager
              </Button>
            )}
            {onRemove && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Two pickers can be on screen at once — a column composing a card, and the
// edit dialog opened over it. A pasted image belongs to whichever came last, so
// each picker listens but only the topmost one acts.
const pasters: object[] = [];

function usePasteCapture(handler: (event: ClipboardEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    const mine = {};
    pasters.push(mine);
    const onPaste = (event: ClipboardEvent) => {
      if (pasters.at(-1) === mine) latest.current(event);
    };

    document.addEventListener("paste", onPaste);
    return () => {
      pasters.splice(pasters.indexOf(mine), 1);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
}

/**
 * Putting files on a card: picked, pasted, or captured from the screen.
 *
 * `onAttached` fires for each file as it lands, which is how the text being
 * written gets told where the file is — an agent cannot look at a screenshot it
 * was never given the path to.
 */
export function AttachmentPicker({
  cardId,
  onAttached,
  compact,
}: {
  cardId: string;
  onAttached?: (file: TmpFile) => void;
  /** Tighter, for the card composer inside a column. */
  compact?: boolean;
}) {
  const { files, error, attach, screenshot, pasteFromClipboard, remove, reveal } =
    useAttachments(cardId);
  const [previewing, setPreviewing] = useState<TmpFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function add(blob: Blob, name: string) {
    const file = await attach(blob, name);
    if (file) onAttached?.(file);
  }

  usePasteCapture((event) => {
    const images = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (images.length > 0) {
      event.preventDefault();
      for (const image of images) void add(image, image.name || pastedName(image));
      return;
    }

    // A paste carrying text belongs to whatever field the cursor is in.
    if (event.clipboardData?.getData("text/plain")) return;

    // Nothing in the event and no text either: on Linux that is a screenshot the
    // webview declined to hand over, so the clipboard is read through the OS.
    // If it holds no image, nothing happens and nothing is said.
    void pasteFromClipboard().then((file) => file && onAttached?.(file));
  });

  const size = compact ? "xs" : "sm";

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <Button size={size} variant="outline" type="button" onClick={() => picker.current?.click()}>
          <PaperclipIcon />
          {compact ? "Files" : "Add files"}
        </Button>
        <Button
          size={size}
          variant="outline"
          type="button"
          onClick={() =>
            void screenshot().then((file) => {
              if (file) onAttached?.(file);
            })
          }
        >
          <CameraIcon />
          Screenshot
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            for (const file of event.target.files ?? []) void add(file, file.name);
            // Cleared, or picking the same file twice fires nothing.
            event.target.value = "";
          }}
        />
      </div>

      <AttachmentStrip
        files={files}
        onOpen={setPreviewing}
        onRemove={(file) => void remove(file.path)}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!compact && <p className="text-xs text-muted-foreground">Paste an image here to add it.</p>}

      {previewing && (
        <AttachmentPreview
          file={previewing}
          onClose={() => setPreviewing(null)}
          onRemove={() => void remove(previewing.path)}
          onReveal={() => void reveal(previewing.path)}
        />
      )}
    </div>
  );
}
