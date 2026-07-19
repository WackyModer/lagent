import readline from 'readline';

/**
 * Shared registry for the interactive session's readline interface.
 *
 * The agent loop (chat.ts) owns the main readline interface and leaves
 * stdin in raw mode so it can intercept Ctrl+C as a raw byte outside of
 * any prompt. Tool handlers that need to read a line of interactive input
 * (e.g. the `clarify` tool) do so via readLineInteractive() below, which
 * uses the shared interface's own `question()` method rather than reading
 * raw stdin bytes itself.
 *
 * This module went through several broken approaches (hand-rolled raw
 * stdin listeners combined with pausing/not pausing the shared readline
 * interface) before settling on `question()` — see the comment inside
 * readLineInteractive() for the full history and why each earlier attempt
 * failed on Windows consoles specifically. `question()` is simpler and
 * correct because it lets `readline` itself manage the stream/listener
 * coordination, instead of a second, competing raw consumer trying to
 * coordinate with it by hand.
 *
 * Coordination during a read still uses `suppressGlobalInterrupt`: it
 * tells chat.ts's global Ctrl+C handler to stand down while a
 * readLineInteractive() call owns the prompt, so its own double-tap-to-
 * exit logic can't fire on a Ctrl+C meant for the prompt. Ctrl+C during
 * the prompt itself is caught via the interface's own 'SIGINT' event,
 * which readline reliably emits while a `question()` is outstanding.
 */

let activeReadline: readline.Interface | null = null;

// Tracks whether an interactive read (e.g. readLineInteractive) currently
// owns stdin. While true, chat.ts's global Ctrl+C handling must not react
// to incoming stdin bytes — otherwise both the global handler and the
// interactive reader's own Ctrl+C handling race on the same keystrokes.
//
// This was the root cause of a bug where answering (or cancelling) a
// `clarify` prompt could unexpectedly exit the whole program: chat.ts's
// permanent `process.stdin.on('data', ...)` listener stayed active while
// readLineInteractive was also reading raw bytes, so a single Ctrl+C (or
// stray leftover byte after Enter) could be consumed by chat.ts's
// double-tap-to-exit logic even though it was intended solely for the
// clarify prompt.
let suppressGlobalInterrupt = false;

/** Called once by chat.ts after it creates its readline interface. */
export function setActiveReadline(rl: readline.Interface): void {
  activeReadline = rl;
}

/** True when the process has an interactive terminal to read from. */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY;
}

/**
 * True while an interactive read (e.g. from the `clarify` tool) currently
 * owns stdin and is handling its own Ctrl+C. The main session's global
 * interrupt handler should check this and no-op while it's true, so the
 * two don't race on the same keystrokes.
 */
export function isInterruptSuppressed(): boolean {
  return suppressGlobalInterrupt;
}

/**
 * Reads a single line of input from the user via the shared readline
 * interface's own `question()` method (see the module doc comment above
 * for why this replaced an earlier hand-rolled raw-byte reader).
 *
 * Because `question()` is used, line editing, backspace, echoing, and
 * Enter-to-submit are all handled by `readline` itself — this function
 * doesn't need to implement any of that manually.
 *
 * Ownership of stdin:
 *  - While this function is waiting on an answer, it is the sole intended
 *    consumer of Ctrl+C. `suppressGlobalInterrupt` is set for the
 *    duration of the read so the main session's global Ctrl+C handler
 *    (in chat.ts) ignores stdin bytes entirely until this settles. This
 *    prevents the main session's double-tap-to-exit logic from ever
 *    firing off a Ctrl+C meant for this prompt.
 *  - The flag is cleared exactly once, atomically with resolving this
 *    function's promise — never before — so there's no window where
 *    interrupts are unsuppressed but this function is still mid-read, or
 *    vice versa.
 *  - Ctrl+C while the question is outstanding is caught via the shared
 *    interface's 'SIGINT' event and resolves this function with `null`.
 *
 * Robustness:
 *  - If stdin is not a TTY (e.g. a piped script), or there is no shared
 *    readline interface yet, the promise resolves with `null` immediately
 *    rather than hanging forever waiting for input that will never come.
 *    This prevents the agent from getting stuck "waiting for input".
 *
 * @param promptText - Text to print before reading (e.g. a question).
 * @returns The trimmed line the user typed, or `null` if they aborted
 *   with Ctrl+C or no interactive terminal/interface was available.
 */
export function readLineInteractive(promptText: string): Promise<string | null> {
  // Non-interactive environments (piped input, no TTY) can't provide a
  // line, and the main chat loop's readline would just hang here. Bail out
  // immediately so the caller can fall back gracefully.
  if (!process.stdin.isTTY) {
    return Promise.resolve(null);
  }

  // No `activeReadline` means there's nothing to prompt through.
  if (!activeReadline) {
    return Promise.resolve(null);
  }

  const rl = activeReadline;

  // We use readline's own built-in `question()` method rather than
  // hand-rolling a raw-byte stdin reader. This function went through
  // three broken approaches before landing here, each trading one bug
  // for another:
  //
  //   1. A raw `process.stdin.on('data', ...)` listener alongside
  //      `rl.pause()`: on Windows consoles, pausing a `readline.Interface`
  //      whose stdin was already externally forced into raw mode (via
  //      `process.stdin.setRawMode(true)` in chat.ts) could cause Node to
  //      see zero active/ref'd handles and exit the whole process
  //      silently — no exception, no log — the instant a clarify prompt
  //      tried to pause and wait for input.
  //   2. Removing the pause to fix that: readline's own internal stdin
  //      listener was then still attached and live, so it consumed every
  //      keystroke *in addition to* our own listener, causing typed input
  //      to be processed twice (typing "3" was read back as "33").
  //   3. Keeping the pause but adding an artificial `setInterval` keepalive
  //      to stop the process from exiting: this did not fix the actual
  //      issue. On Windows, `readline.Interface.pause()` on a stream
  //      already in raw mode doesn't just detach readline's own listener —
  //      it can call `.pause()` on the underlying stdin stream itself,
  //      which stops the stream from emitting `'data'` to ANY listener,
  //      including ours. That's why input (and even Ctrl+C, which relied
  //      on the same `'data'` event) stopped working entirely.
  //
  // `rl.question()` sidesteps all of this: it's the API `readline` itself
  // provides for exactly this purpose, so Node manages the underlying
  // stream/listener/pause state internally and correctly (it's the same
  // interface already successfully reading the main chat prompt), instead
  // of us trying to coordinate a second, competing consumer of the same
  // stream by hand.
  suppressGlobalInterrupt = true;

  return new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.removeListener('SIGINT', onSigint);
      process.stdin.removeListener('keypress', onKeypressCtrlC);
      suppressGlobalInterrupt = false;
      resolve(value);
    };

    // Primary Ctrl+C path: readline's own 'SIGINT' event, emitted while a
    // question() is outstanding and it owns the terminal.
    const onSigint = () => {
      finish(null);
    };
    rl.once('SIGINT', onSigint);

    // Belt-and-suspenders Ctrl+C path: readline's own 'SIGINT' event is
    // the primary signal, but we also listen for the raw keypress
    // directly, purely to detect Ctrl+C — never to read or buffer the
    // answer itself, which stays entirely readline's job via question().
    // This mirrors chat.ts's own Ctrl+C detection (see the comments
    // there for why 'keypress' is used instead of a manual raw-mode byte
    // listener) so both consumers agree on how Ctrl+C is observed. This
    // listener does nothing except call finish(null); it cannot cause
    // duplicated input because it never echoes or accumulates characters.
    const onKeypressCtrlC = (_str: string, key: { sequence?: string } | undefined) => {
      if (key?.sequence === '\u0003') {
        finish(null);
      }
    };
    process.stdin.on('keypress', onKeypressCtrlC);

    rl.question(promptText, (answer: string) => {
      finish(answer.trim());
    });
  });
}