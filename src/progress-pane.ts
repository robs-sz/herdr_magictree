/**
 * The progress pane: a spinner that lives exactly as long as one `magictree up`.
 *
 * `src/open-progress-pane.ts` opens it as an unfocused split in the worktree's
 * workspace, so a bootstrap that runs for minutes is visible without taking the
 * keyboard, and closes itself when the run settles — the pane disappears with
 * this process. That is why the pane owns no run state: it polls the record the
 * runner writes and exits on the first terminal one, so a spinner can never
 * outlive its run, and a run whose runner died is reported instead of spun on
 * forever.
 *
 * Stdout here is the pane, so this file must not use `log()` (it copies to
 * stdout) and must never write anything but a frame.
 */
import { basename } from "node:path";
import { capLine, elapsedText, lastLogLine, logQuiet } from "./log.ts";
import { pidAlive, readState, type WorktreeRecord } from "./state.ts";

/** Ten frames a second: smooth enough to read as motion, cheap enough to leave alone. */
const FRAME_MS = 100;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The record only changes when the runner writes it, so once a second is plenty. */
const POLL_MS = 1000;

/** A record that never appears means the runner died before it could register. */
const REGISTER_TIMEOUT_MS = 30_000;

/** Where the log tail is trimmed: the pane is a few rows, not a log viewer. */
const TAIL_CHARS = 200;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type Watch = { record: WorktreeRecord | undefined; tail: string };

function watch(key: string): Watch {
  const record = readState().worktrees[key];
  return { record, tail: record?.log_path ? lastLogLine(record.log_path, TAIL_CHARS) : "" };
}

function label(record: WorktreeRecord | undefined): string {
  if (record === undefined) return "magictree up";
  return record.label ?? record.branch ?? basename(record.path);
}

/** Two rows: the spinner and the run's own last line, dimmed behind it. */
function frameLines(current: Watch, glyph: string, startedAt: number): string[] {
  // Capped before styling: `capLine` counts characters, so escape bytes would
  // otherwise eat into the visible width.
  const width = process.stdout.columns ?? 80;
  const plain = `starting ${label(current.record)}  ${elapsedText(Date.now() - startedAt)}`;
  const lines = [`${DIM}${glyph}${RESET} ${capLine(plain, width - 3)}`];
  if (current.tail.length > 0) lines.push(`${DIM}  ${capLine(current.tail, width - 4)}${RESET}`);
  return lines;
}

/**
 * Redraw in place. The pane is ours alone, and we never write more rows than it
 * has, so home is the first row and nothing has scrolled away.
 */
function paint(lines: string[]): void {
  process.stdout.write(`\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}\x1b[K\x1b[J`);
}

const key = process.env.MAGICTREE_RUN_KEY ?? "";
const interactive = process.stdin.isTTY === true;

function quit(code: number, reason: string): never {
  logQuiet("progress", `${key || "<no key>"} pane exit: ${reason}`);
  if (interactive) process.stdout.write("\x1b[?25h");
  process.exit(code);
}

if (key.length === 0) {
  process.stdout.write("magictree: nothing to follow (MAGICTREE_RUN_KEY is unset)\n");
  process.exit(1);
}

const startedAt = Date.now();

if (interactive) {
  // The pane is unfocused, so this only fires once the user looks at it and
  // types: dismissing the spinner must not touch the run, which is detached.
  process.stdout.write("\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once("data", () => quit(0, "dismissed by keypress"));
}

let tick = 0;
let current = watch(key);
let polledAt = Date.now();

for (;;) {
  const now = Date.now();
  if (now - polledAt >= POLL_MS) {
    polledAt = now;
    current = watch(key);
  }

  const record = current.record;
  if (record !== undefined) {
    if (record.status !== "running") quit(0, `run ${record.status}`);
    if (record.pid !== null && !pidAlive(record.pid)) {
      // The runner writes its terminal state and exits in the same instant,
      // so a snapshot taken just before that write sees a live run with a
      // dead pid. Re-read once before declaring the run orphaned.
      const fresh = readState().worktrees[key];
      if (fresh === undefined || fresh.status === "running") {
        quit(1, `runner pid ${record.pid} is gone`);
      }
      quit(0, `run ${fresh.status}`);
    }
  } else if (now - startedAt > REGISTER_TIMEOUT_MS) {
    quit(1, "no run record appeared");
  }

  paint(frameLines(current, FRAMES[tick % FRAMES.length]!, startedAt));
  tick++;
  await Bun.sleep(FRAME_MS);
}
