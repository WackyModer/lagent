import chalk from 'chalk';
import type { ToolModule } from '../types/common';
import { readLineInteractive } from './user_input';

/**
 * Validates and normalizes the answer options passed by the model.
 *
 * Accepts either a JSON array of strings, or a single newline/comma
 * separated string. Returns a trimmed, non-empty list of options, or an
 * empty array if none could be parsed.
 */
function parseOptions(raw: unknown): string[] {
  if (raw == null) return [];

  let candidates: string[] = [];

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];

    // Try JSON array first (e.g. ["A", "B", "C"]).
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        candidates = parsed.map((x) => String(x)).filter((x) => x.trim() !== '');
        return candidates;
      }
    } catch {
      /* fall through to delimiter splitting */
    }

    // Otherwise treat as newline- or comma-separated values.
    candidates = trimmed
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return candidates;
  }

  if (Array.isArray(raw)) {
    candidates = raw.map((x) => String(x)).filter((x) => x.trim() !== '');
    return candidates;
  }

  return [];
}

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'clarify',
      description:
        'Temporarily halt the run to ask the user a clarifying question and collect their answer. ' +
        'Present a question plus a list of suggested answer options. The user may pick an option by ' +
        'typing its number (1, 2, 3, ...) or type their own free-form answer. Use this when you are ' +
        'genuinely blocked or need a decision from the user before proceeding (e.g. in autonomous task ' +
        'mode, or when a request is ambiguous). Do not use it for routine steps you can decide yourself.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The clarifying question to ask the user.',
          },
          options: {
            type: 'string',
            description:
              'Suggested answer options. Provide a JSON array of strings (e.g. ["Red","Green","Blue"]) ' +
              'or a newline/comma-separated list. The user can pick one by number or type their own.',
          },
        },
        required: ['question'],
      },
    },
  },

  /**
   * Halts execution and prompts the user for clarification.
   *
   * Note: this handler intentionally reads directly from stdin via
   * readLineInteractive() rather than reacting to the `signal` param that
   * runToolCalls() passes to every handler. readLineInteractive() takes
   * exclusive ownership of Ctrl+C handling for the duration of the read
   * (see tools/user_input.ts), so a Ctrl+C here is handled as "cancel
   * clarification" rather than being picked up by the session's global
   * interrupt handler in chat.ts.
   *
   * @param args - { question, options? }
   * @returns A string reporting the user's chosen answer (or that they
   *   declined / aborted), which is fed back to the model as the tool
   *   result so it can continue accordingly.
   */
  async handler(args: Record<string, unknown>) {
    const question = (args.question as string) ?? '';
    const options = parseOptions(args.options);

    if (!question.trim()) {
      return 'Error: clarify requires a non-empty "question".';
    }

    console.log('');
    console.log(chalk.magenta('[?] The assistant needs clarification:'));
    console.log(`  ${chalk.white(question)}`);

    if (options.length > 0) {
      console.log(chalk.gray('  Choose an option by number, or type your own answer:'));
      options.forEach((opt, i) => {
        console.log(`    ${chalk.cyan(`${i + 1}.`)} ${opt}`);
      });
    } else {
      console.log(chalk.gray('  Type your answer (or press Ctrl+C to skip):'));
    }

    const promptText = options.length > 0
      ? chalk.cyan('  your answer › ')
      : chalk.cyan('  answer › ');

    const answer = await readLineInteractive(promptText);

    if (answer === null) {
      // Two distinct situations resolve to `null`:
      //  1. The user aborted with Ctrl+C in an interactive session.
      //  2. There is no interactive terminal (stdin is not a TTY, e.g. a
      //     piped/non-interactive script) or stdin reached EOF. In that
      //     case `readLineInteractive` bails out immediately instead of
      //     hanging forever waiting for input that will never arrive —
      //     which previously caused the agent to stall and the process to
      //     drop back to the shell.
      const interactive = process.stdin.isTTY;
      if (interactive) {
        console.log(chalk.yellow('[▲] Clarification skipped by user (Ctrl+C).'));
        return 'The user skipped the clarification question (pressed Ctrl+C) and did not provide an answer.';
      }

      console.log(chalk.yellow('[▲] Clarification skipped: no interactive terminal (non-TTY stdin).'));
      return 'The clarification question could not be asked because this session has no interactive terminal ' +
        '(stdin is not a TTY). The user did not provide an answer. Proceed using sensible defaults or your ' +
        'best judgment rather than blocking on input.';
    }

    // If the user entered a bare number that matches an option, resolve it
    // to the option text so the model gets a clear, descriptive answer.
    const numMatch = answer.match(/^\s*(\d+)\s*$/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < options.length) {
        const chosen = options[idx];
        console.log(chalk.green(`\n[✓] User selected option ${idx + 1}: ${chosen}`));
        return `User answered: "${chosen}" (selected option ${idx + 1} of ${options.length}).`;
      }
      // Number is out of range — fall through and treat the typed text as a
      // free-form answer (so the model can react to an invalid choice).
    }

    if (answer === '') {
      console.log(chalk.yellow('[▲] Clarification answered with empty input.'));
      return 'The user provided an empty answer (no text entered).';
    }

    console.log(chalk.green(`\n[✓] User answer: ${answer}`));
    const prefix = options.length > 0
      ? `User typed their own answer (not one of the ${options.length} options): `
      : 'User answered: ';
    return `${prefix}"${answer}".`;
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    const q = (args.question as string) ?? '';
    const snippet = q.length > 60 ? q.slice(0, 57) + '...' : q;
    return `asking for clarification: ${chalk.magenta(snippet)}`;
  },
};

export = tool;