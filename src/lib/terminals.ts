import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import { detectApproval, stripAnsi } from "./approval";
import { hasGoneIdle } from "./idle";
import { recentLines } from "./recent";
import { detectStatus } from "./status";
import { homeDir } from "@tauri-apps/api/path";

import { terminal as ptyApi, tmp as tmpApi, type SpawnOptions } from "./ipc";
import { mentionedFiles } from "./mentioned";

export interface Session {
  id: string;
  title: string;
  cwd: string;
  taskId?: string;
  exitCode: number | null;
  /** The agent printed something that reads like a question and stopped. */
  waiting: boolean;
  /** Set once the agent has gone idle and the run was closed, though it is still up. */
  finished: boolean;
  /** The agent's own status line, e.g. "Mustering… (12s)". */
  status: string | null;
  /** The last few lines of conversation on screen, for the card's mini-terminal. */
  recent: string[];
}

interface Attached extends Omit<Session, "finished"> {
  term: Terminal;
  fit: FitAddon;
  onExit?: (code: number, transcript: string) => void;
  onWaiting?: (waiting: boolean) => void;
  onReady?: () => void;
  onIdle?: (transcript: string) => void;
  ready?: boolean;
  /** Output arrived since the screen was last read. */
  dirty: boolean;
  /** The stripped tail as it last actually changed, and when that was. */
  settled: string;
  settledAt: number;
  /** Set once the idle sweep has closed the run, so it is closed once. */
  reported?: "done";
  /** Paths the card's store has already dealt with, so each is offered once. */
  offered: Set<string>;
  /** Recent output, kept only long enough to spot a prompt at the end of it. */
  tail: string;
  // The xterm canvas lives here, detached from React. Switching views moves
  // this node instead of rebuilding the terminal, so scrollback survives.
  host: HTMLDivElement;
}

type Listener = () => void;

const sessions = new Map<string, Attached>();
const listeners = new Set<Listener>();
let wired = false;

// The pty starts producing the moment Rust spawns it, which can be before the
// spawn call has even returned an id to us. Anything that arrives for an id we
// have not registered yet is held here and replayed on registration — without
// this, a command that fails instantly loses its exit event and leaves the card
// stuck in "running" forever.
const early = new Map<string, { chunks: Uint8Array[]; exit?: number }>();

function hold(id: string): { chunks: Uint8Array[]; exit?: number } {
  const existing = early.get(id);
  if (existing) return existing;
  const created = { chunks: [] as Uint8Array[] };
  early.set(id, created);
  return created;
}

// useSyncExternalStore compares snapshots by identity, so the array is rebuilt
// only when something actually changes — never on every read.
const EMPTY: Session[] = [];
let snapshot: Session[] = EMPTY;

function notify() {
  snapshot = [...sessions.values()].map(
    ({ id, title, cwd, taskId, exitCode, waiting, reported, status, recent }) => ({
      id,
      title,
      cwd,
      taskId,
      exitCode,
      waiting,
      finished: reported !== undefined,
      status,
      recent,
    }),
  );
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function list(): Session[] {
  return snapshot;
}

export function empty(): Session[] {
  return EMPTY;
}

export function find(taskId: string): Session | undefined {
  return list().find((session) => session.taskId === taskId);
}

/** Slightly under the interface size: a monospace face reads larger at the
 *  same nominal size, and the terminal is the densest thing on screen. Never
 *  below 13px, where antialiasing starts costing more than the density gains. */
function terminalFontSize(): number {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Math.max(13, Math.round((Number.isFinite(root) ? root : 16) * 0.9));
}

function codeFont(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
}

/**
 * Cell size is measured from the font once, and re-measured only when a font
 * option actually changes — so a face that arrives after that first measure
 * leaves every glyph narrow inside a cell sized for the fallback, with a gap
 * beside it for the rest of the session. Re-setting a font option to the value
 * it already holds does not force a re-measure, so the face has to be loaded
 * before the terminal is built.
 */
async function fontReady(family: string, size: number): Promise<void> {
  if (!document.fonts) return;
  try {
    await document.fonts.load(`${size}px ${family}`);
    await document.fonts.ready;
  } catch {
    // A face that will not load still renders through the rest of the stack.
  }
}

/**
 * What makes an agent's output readable rather than merely present.
 *
 * Agents write most of their output dim, which on a dark background lands
 * somewhere near the surface colour — hence the contrast floor, which lifts
 * only text that is genuinely too faint and leaves everything else alone.
 * `rescaleOverlappingGlyphs` is for the characters no monospace face has at the
 * right width — spinners, powerline arrows, the odd emoji — which otherwise
 * spill into the cell beside them and smear the line.
 */
const LEGIBILITY = {
  // A little air: agent output is dense, and 1.0 line height runs together.
  lineHeight: 1.3,
  letterSpacing: 0,
  minimumContrastRatio: 3,
  rescaleOverlappingGlyphs: true,
} as const;

function theme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--surface"),
    foreground: token("--text"),
    cursor: token("--brand"),
    selectionBackground: token("--border-strong"),
  };
}

/**
 * How long a session may sit completely unchanged before it counts as finished.
 *
 * An interactive agent does not exit when its work is done — it returns to its
 * own prompt and waits — and the board no longer asks it to announce anything,
 * so going idle is the only end of a run.
 *
 * A working agent is never still: its status line counts seconds and its
 * spinner turns. So a session still showing a status line is given a long
 * window, only as a net for a status that froze on screen; the normal path is
 * the status line disappearing and the screen then standing still.
 */
const IDLE_AFTER = 120_000;
/** The shorter wait for a session that is showing no status line at all — it is
 *  sitting at its own prompt, not working, so a card need not hang on for the
 *  full window before it moves. */
const PARKED_AFTER = 12_000;
const IDLE_CHECK = 2_000;
const SCREEN_SCAN = 400;

function sweepIdle() {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.onIdle) continue;
    const idle = hasGoneIdle(
      {
        // Having drawn anything at all, rather than having shown a status line:
        // an agent that never prints one must still be swept up.
        ready: session.settled !== "",
        waiting: session.waiting,
        status: session.status,
        settledAt: session.settledAt,
        closed: session.reported !== undefined || session.exitCode !== null,
      },
      now,
      IDLE_AFTER,
      PARKED_AFTER,
    );
    if (!idle) continue;

    session.reported = "done";
    session.status = null;
    notify();
    session.onIdle(stripAnsi(session.tail).trimEnd());
  }
}

async function wire() {
  if (wired) return;
  wired = true;
  setInterval(scanScreens, SCREEN_SCAN);
  setInterval(sweepIdle, IDLE_CHECK);
  await ptyApi.onOutput(({ id, bytes }) => {
    const session = sessions.get(id);
    if (!session) {
      hold(id).chunks.push(bytes);
      return;
    }
    session.term.write(bytes);
    observe(session, bytes);
  });
  await ptyApi.onExit(({ id, code }) => {
    if (sessions.has(id)) finished(id, code);
    else hold(id).exit = code;
  });
}

const TAIL_LIMIT = 2000;
const decoder = new TextDecoder();

/** Watches the output for a question the agent is now blocked on. */
/**
 * What is actually on the terminal right now.
 *
 * The byte stream is a poor stand-in for this: text that scrolled away is still
 * in it, and a screen redrawn in place arrives as frame after frame of the same
 * line. A question the agent is still showing has to be read from the screen, or
 * it goes unnoticed the moment enough output follows it.
 */
function screenText(session: Attached): string {
  const buffer = session.term.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < session.term.rows; row += 1) {
    lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trimEnd();
}

let home: string | undefined;
void homeDir()
  .then((dir) => {
    home = dir;
  })
  .catch(() => undefined);

/** Puts screenshots and reports the agent mentions on its card as they appear. */
function collectFiles(session: Attached, screen: string) {
  if (!session.taskId) return;
  const fresh = mentionedFiles(`${screen}\n${stripAnsi(session.tail)}`, home).filter(
    (path) => !session.offered.has(path),
  );
  if (fresh.length === 0) return;
  void tmpApi
    .collect(session.taskId, fresh)
    .then((settled) => settled.forEach((path) => session.offered.add(path)))
    .catch(() => undefined);
}

/** Reads the screen of every session that has produced output since last time. */
function scanScreens() {
  for (const session of sessions.values()) {
    if (!session.dirty) continue;
    session.dirty = false;

    const screen = screenText(session);
    if (screen !== session.settled) {
      session.settled = screen;
      session.settledAt = Date.now();
    }

    collectFiles(session, screen);

    const status = detectStatus(screen);
    if (status && !session.ready) {
      session.ready = true;
      session.onReady?.();
    }

    const recent = recentLines(screen);
    const recentChanged = recent.join("\n") !== session.recent.join("\n");
    if (recentChanged) session.recent = recent;

    const waiting = detectApproval(screen);
    const changed = status !== session.status || waiting !== session.waiting;
    session.status = status;
    if (!changed) {
      if (recentChanged) notify();
      continue;
    }

    const wasWaiting = session.waiting;
    session.waiting = waiting;
    notify();
    if (waiting !== wasWaiting) session.onWaiting?.(waiting);
  }
}

function observe(session: Attached, bytes: Uint8Array) {
  session.tail = (session.tail + decoder.decode(bytes, { stream: true })).slice(-TAIL_LIMIT);
  // The screen is read on a timer instead of per chunk: a busy agent writes far
  // more often than anyone can read.
  session.dirty = true;

  // The status itself is read from the screen only: the byte tail keeps old
  // spinner frames after the agent has stopped, which would hold a finished card
  // on Working.
  if (!session.ready && detectStatus(session.tail)) {
    session.ready = true;
    session.onReady?.();
  }
  const waiting = detectApproval(session.tail);
  if (waiting === session.waiting) return;

  const wasWaiting = session.waiting;
  session.waiting = waiting;
  notify();
  if (waiting !== wasWaiting) session.onWaiting?.(waiting);
}

function finished(id: string, code: number) {
  const session = sessions.get(id);
  if (!session) return;
  session.exitCode = code;
  session.status = null;
  // A finished process is not waiting on anyone.
  if (session.waiting) {
    session.waiting = false;
    session.onWaiting?.(false);
  }
  session.term.write(`\r\n\x1b[2m— exited with code ${code} —\x1b[0m\r\n`);
  notify();
  session.onExit?.(code, stripAnsi(session.tail).trimEnd());
}

function replay(id: string) {
  const held = early.get(id);
  if (!held) return;
  early.delete(id);

  const session = sessions.get(id);
  for (const chunk of held.chunks) session?.term.write(chunk);
  if (held.exit !== undefined) finished(id, held.exit);
}

// Live terminals keep the theme they were created with, so a theme change has
// to be pushed into each one.
export async function retheme(): Promise<void> {
  const font = codeFont();
  const size = terminalFontSize();
  await fontReady(font, size);
  for (const session of sessions.values()) {
    session.term.options.theme = theme();
    session.term.options.fontFamily = font;
    session.term.options.fontSize = size;
    session.term.options.lineHeight = LEGIBILITY.lineHeight;
    session.term.options.letterSpacing = LEGIBILITY.letterSpacing;
    session.term.options.minimumContrastRatio = LEGIBILITY.minimumContrastRatio;
    if (session.host.clientWidth > 0) session.fit.fit();
  }
}

/**
 * One terminal per card, enforced here rather than trusted to every caller:
 * a second session on the same card would be a second agent on the same
 * worktree, both writing the same files.
 */
export async function open(
  options: SpawnOptions & {
    title: string;
    taskId?: string;
    onExit?: (code: number, transcript: string) => void;
    onWaiting?: (waiting: boolean) => void;
    onReady?: () => void;
    onIdle?: (transcript: string) => void;
  },
): Promise<string> {
  await wire();

  if (options.taskId) {
    const existing = find(options.taskId);
    if (existing) {
      focus(existing.id);
      return existing.id;
    }
  }

  const fontFamily = codeFont();
  const fontSize = terminalFontSize();
  await fontReady(fontFamily, fontSize);

  const term = new Terminal({
    fontFamily,
    fontSize,
    ...LEGIBILITY,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: theme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const host = document.createElement("div");
  host.style.height = "100%";
  term.open(host);

  // The canvas renderer repaints the whole grid; an agent redrawing a spinner
  // several times a second is exactly the case it handles worst.
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    // Some machines have no working WebGL; the default renderer still works.
  }

  const id = await ptyApi.spawn({
    cwd: options.cwd,
    command: options.command,
    env: options.env,
    cols: term.cols,
    rows: term.rows,
    shareAs: options.taskId ? `agent-board-${options.taskId}` : undefined,
  });

  term.onData((data) => void ptyApi.write(id, data));
  term.onResize(({ cols, rows }) => void ptyApi.resize(id, cols, rows));

  sessions.set(id, {
    id,
    title: options.title,
    cwd: options.cwd,
    taskId: options.taskId,
    exitCode: null,
    waiting: false,
    status: null,
    recent: [],
    offered: new Set(),
    tail: "",
    settled: "",
    settledAt: Date.now(),
    dirty: false,
    onExit: options.onExit,
    onWaiting: options.onWaiting,
    onIdle: options.onIdle,
    onReady: options.onReady,
    term,
    fit,
    host,
  });
  notify();
  replay(id);
  return id;
}

// Moves the live terminal node into `container` and keeps it sized to it.
export function attach(id: string, container: HTMLElement): () => void {
  const session = sessions.get(id);
  if (!session) return () => {};

  container.appendChild(session.host);

  // A hidden pane measures 0×0, and fitting to that leaves a one-column grid
  // that clips everything once the pane is shown again. Panes here are hidden
  // rather than unmounted, so this is the normal case, not an edge one.
  let pending = 0;
  const refit = () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) session.fit.fit();
    }, 60);
  };

  const observer = new ResizeObserver(refit);
  observer.observe(container);
  window.addEventListener("resize", refit);
  refit();
  session.term.focus();

  return () => {
    window.clearTimeout(pending);
    observer.disconnect();
    window.removeEventListener("resize", refit);
    session.host.remove();
  };
}

/** The tmux session a card's terminal can be attached to from elsewhere. */
export function shareName(taskId: string): string {
  return `agent-board-${taskId}`;
}

/**
 * Whether the card's agent is still alive somewhere this app can rejoin.
 *
 * The pty went with the window that owned it, but the agent runs inside tmux,
 * which did not — so a card whose terminal is gone is not necessarily a card
 * whose agent is gone.
 */
export function resumable(taskId: string): Promise<boolean> {
  return ptyApi.shared(shareName(taskId)).catch(() => false);
}

/** The transcript so far, for a run someone finishes by hand. */
export function transcript(id: string): string {
  const session = sessions.get(id);
  return session ? stripAnsi(session.tail).trimEnd() : "";
}

/** Ctrl-C: stops what the agent is doing without ending the session. */
export function interrupt(id: string): void {
  void ptyApi.write(id, "\x03").catch(() => undefined);
}

/** Types a line into the agent, as a person would. */
export function send(id: string, line: string): void {
  void ptyApi.write(id, `${line}\r`).catch(() => undefined);
}

/** Puts the keyboard back into a specific terminal after a click or a split. */
export function focus(id: string): void {
  sessions.get(id)?.term.focus();
}

export async function close(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  if (session.exitCode === null) {
    await ptyApi.kill(id).catch(() => undefined);
  }
  session.term.dispose();
  sessions.delete(id);
  early.delete(id);
  notify();
}
