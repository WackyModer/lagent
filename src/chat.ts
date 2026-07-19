import readline from 'readline';
import os from 'os';
import util from 'util';
import path from 'path';
import { ollama, chalk } from './init';
import type { Message, ChatResponse } from 'ollama';
import type { ChatMessage, ToolCall, ToolSchema, StreamChunk } from './types/common';
import { schemas as toolSchemas, handlers as toolHandlers, describers as toolDescribers, names as toolNames } from './tools';
import { setActiveReadline, isInterruptSuppressed } from './tools/user_input';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

// Tracks the AbortController for whatever model request is currently in
// flight, so SIGINT (Ctrl+C) can cancel just the generation instead of
// killing the whole process. Set right before a request starts and cleared
// in a `finally` once the stream ends, however it ends.
let currentAbortController: AbortController | null = null;

// Tracks the AbortController for whatever tool/task the model is currently
// running (e.g. a shell command via execute_command). When a generation
// finishes and the model moves on to actually doing work, this is set so a
// SIGINT (Ctrl+C) can cancel the in-progress task too — not just the model
// run. Cleared once the tool batch completes, however it ends.
let currentTaskAbortController: AbortController | null = null;

// Which backend chat() should talk to ('ollama' | 'openrouter'). Set once
// by chatHandoff() at session start.
let globalProvider: 'ollama' | 'openrouter' | null = null;

// The shape ollama's `chat({ stream: true })` returns: an async-iterable
// object that also exposes its own `.abort()` method. The SDK doesn't
// export a clean public type for it, so we describe just the parts we use.
interface OllamaStreamResponse {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
  abort?: () => void;
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

function toOpenRouterMessages(history: ChatMessage[]) {
  return history.map((msg) => {
    const out: Record<string, unknown> = { role: msg.role };

    out.content =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;

    if (msg.tool_calls) {
      out.tool_calls = msg.tool_calls.map((tc: ToolCall) => ({
        id: tc.id,
        type: tc.type || 'function',
        function: {
          name: tc.function.name,
          arguments:
            typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments),
        },
      }));
    }

    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.name) out.name = msg.name;

    return out;
  });
}

/**
 * Sends the conversation to the configured provider and returns an async
 * iterator of streamed chunks shaped like Ollama's:
 * { message: { role, content, tool_calls?, thinking? }, done }
 */
async function chat(
  model: string,
  history: ChatMessage[],
  tools: ToolSchema[],
  think: string | boolean,
  abortController: AbortController
): Promise<OllamaStreamResponse | AsyncGenerator<StreamChunk>> {
  let response: OllamaStreamResponse | AsyncGenerator<StreamChunk>;

  if (globalProvider === 'ollama') {
    const request = {
      model,
      messages: history as unknown as Message[],
      think: think as unknown as boolean | 'high' | 'medium' | 'low',
      tools,
      stream: true,
      options: {
        num_predict: -1, // generate until the model stops or context fills
      },
    } as unknown as Parameters<typeof ollama.chat>[0];

    response = (await ollama.chat(request)) as unknown as OllamaStreamResponse;

    // Bridge our AbortController to ollama's own abort mechanism. The
    // returned stream object (AbortableAsyncIterator) exposes its own
    // .abort() method backed by its own internal controller — that's the
    // only thing that actually stops the request. Without this, Ctrl+C
    // during generation does nothing for the ollama provider.
    //
    // NOTE: this listener is registered up front, before the signal has
    // fired, so it will correctly run exactly once whenever abort() is
    // eventually called (whether that happens here or from the SIGINT
    // handler in runTurn). Do NOT try to re-register a fresh listener
    // from inside an abort handler — a signal that has already fired will
    // silently ignore any listener added after the fact.
    if (response && typeof response.abort === 'function') {
      const streamResp = response;
      abortController.signal.addEventListener(
        'abort',
        () => {
          try {
            streamResp.abort!();
          } catch {
            /* ignore */
          }
        },
        { once: true }
      );
    }
  } else if (globalProvider === 'openrouter') {
    const httpResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: toOpenRouterMessages(history),
        tools,
        stream: true,
        ...(think !== undefined && {
          reasoning: { enabled: think === 'true' },
        }),
      }),
      signal: abortController.signal,
    });

    if (!httpResponse.ok || !httpResponse.body) {
      const errText = await httpResponse.text().catch(() => ''); // eslint-disable-line @typescript-eslint/no-unused-vars
      throw new Error(`OpenRouter request failed: ${httpResponse.status} ${errText}`);
    }

    response = openRouterStreamToOllamaShape(httpResponse);
  } else {
    throw new Error(`Unknown provider: ${globalProvider}`);
  }

  return response;
}

// Adapts OpenRouter's OpenAI-style SSE stream into an async generator
// that yields chunks shaped like Ollama's: { message: { role, content, tool_calls }, done }
async function* openRouterStreamToOllamaShape(httpResponse: Response): AsyncGenerator<StreamChunk> {
  const reader = httpResponse.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // Accumulate partial tool_calls across deltas, since OpenAI-style
  // streaming sends tool call arguments incrementally by index.
  const toolCallAcc = new Map<number, { id?: string; type: string; function: { name: string; arguments: string } }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() as string; // keep last partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { message: { role: 'assistant', content: '' }, done: true };
          return;
        }

        let parsed: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // skip malformed/keepalive lines
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const finishReason = choice.finish_reason;

        // Merge streamed tool_call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing =
              toolCallAcc.get(idx) ||
              ({
                id: tc.id,
                type: 'function',
                function: { name: '', arguments: '' },
              } as { id?: string; type: string; function: { name: string; arguments: string } });
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            toolCallAcc.set(idx, existing);
          }
        }

        const isFinal = finishReason != null;

        const message: StreamChunk['message'] = {
          role: delta.role || 'assistant',
          content: delta.content ?? '',
        };

        // Include reasoning/thinking content if present (OpenRouter "reasoning" field)
        if (delta.reasoning) {
          message.thinking = delta.reasoning;
        }

        if (isFinal && toolCallAcc.size > 0) {
          message.tool_calls = Array.from(toolCallAcc.values()).map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: safeParseJSON(tc.function.arguments) as string | Record<string, unknown>,
            },
          }));
        }

        yield { message, done: isFinal };

        if (isFinal) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function safeParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str; // fall back to raw string if malformed
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Logs an error with as much diagnostic detail as possible: message, name,
 * stack trace, cause, and any extra enumerable properties (Ollama/HTTP
 * client errors often attach things like `error`, `status`, `response`).
 */
function logDetailedError(context: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(chalk.red(`\n[x] ${context}`));

  if (err instanceof Error) {
    console.error(chalk.red(`  name: ${err.name}`));
    console.error(chalk.red(`  message: ${err.message}`));

    if (err.cause) {
      console.error(chalk.red(`  cause: ${util.inspect(err.cause, { depth: 4 })}`));
    }

    // Surface any extra enumerable own-properties beyond the standard
    // Error fields (e.g. err.status, err.response, err.data).
    const standardKeys = new Set(['name', 'message', 'stack', 'cause']);
    const extraKeys = Object.keys(err).filter((k) => !standardKeys.has(k));
    if (extraKeys.length > 0) {
      const extraProps: Record<string, unknown> = {};
      for (const k of extraKeys) (extraProps as Record<string, unknown>)[k] = (err as unknown as Record<string, unknown>)[k];
      console.error(chalk.red(`  details: ${util.inspect(extraProps, { depth: 4 })}`));
    }

    if (err.stack) {
      console.error(
        chalk.gray(`  stack:\n${err.stack.split('\n').map((l) => '    ' + l).join('\n')}`)
      );
    }
  } else {
    console.error(chalk.red(`  ${util.inspect(err, { depth: 4 })}`));
  }

  if (Object.keys(extra).length > 0) {
    console.error(chalk.red(`  context: ${util.inspect(extra, { depth: 4 })}`));
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Builds a system prompt describing the current environment so the
 * model knows what platform/shell it's operating in before it uses tools.
 */
function buildSystemPrompt(): string {
  const platform = os.platform(); // 'win32', 'linux', 'darwin'
  const shell = platform === 'win32' ? 'cmd.exe / PowerShell' : process.env.SHELL || 'sh';

  return [
    'You are an AI assistant with access to tools that can read files and execute shell commands on the user\'s machine.',
    'You operate in two modes: normal chat, where you respond to one user message at a time and should stop and',
    'ask when something is ambiguous or risky, and autonomous task mode (triggered by the user via /task), where you',
    'work through a goal end-to-end across multiple tool calls without waiting for user input between steps UNLESS',
    'you need clarification, which you call the clarify tool for.',
    '',
    '# System details',
    `- OS: ${platform} (${os.release()})`,
    `- Shell: ${shell}`,
    `- Current working directory: ${process.cwd()}`,
    `- Home directory: ${os.homedir()}`,
    `- Node.js: ${process.version}`,
    '',
    '# Tool usage guidelines',
    '- Use list_directory or glob to discover files before reading or editing them — do not guess at paths.',
    '- Use search_files to find where something is defined or used before reading whole files.',
    '- Use read_file to inspect actual file contents before making claims about them; never assume file contents.',
    '- Use write_file to create a file or overwrite it entirely; use edit_file for a targeted find-and-replace within an existing file.',
    '- Use execute_command for anything not covered by the other tools. Prefer safe, non-destructive commands.',
    '  Ask the user for confirmation before running anything that deletes, overwrites, or irreversibly changes data,',
    '  unless you are in autonomous task mode and the user\'s task explicitly authorized it.',
    '- Use fetch_url to retrieve the contents of a web page or API endpoint when you need current or external information.',
    '- Prefer the smallest, most targeted tool call that answers the question — do not read entire large files or',
    '  directories when a search or a partial read would do.',
    `- Use ${platform === 'win32' ? 'Windows-style' : 'POSIX-style'} commands and paths appropriate for this shell.`,
    '- Paths may be relative to the working directory above unless the user specifies otherwise.',
    '',
    '# Autonomous task mode',
    '- You will not be re-prompted with the original request between tool calls — keep working through the task',
    '  using tool results as they come back, without waiting for the user.',
    '- Only stop and call task_complete once the task is fully done, or once you are genuinely stuck and cannot',
    '  proceed without user input (in which case call task_complete anyway and explain what is blocking you).',
    '- Do not call task_complete prematurely, and do not call it more than once.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Runs all tool calls requested by the model and returns tool result messages.
 *
 * Cancellation: `signal` is the AbortSignal for this task batch. It is passed
 * down to each tool handler so a SIGINT (Ctrl+C) can interrupt the model's
 * task (e.g. kill a running shell command) rather than only the model run.
 * If the signal fires mid-task, handlers are expected to reject/abort, and
 * any thrown error here is reported back as a cancellation message.
 *
 * Note: some tools (e.g. `clarify`) intentionally read directly from stdin
 * for interactive input rather than reacting to `signal`. Those tools
 * suppress the global Ctrl+C handling themselves for the duration of their
 * read (see tools/user_input.ts's `isInterruptSuppressed`), so a Ctrl+C
 * while they're waiting on input is handled by them, not by this loop or
 * by the session-level handler in chatHandoff().
 *
 * @param toolCalls - The tool calls the model requested.
 * @param signal - Signal to cancel an in-progress task.
 */
async function runToolCalls(toolCalls: ToolCall[], signal?: AbortSignal): Promise<ChatMessage[]> {
  const results: ChatMessage[] = [];
  console.log(chalk.blue('[>] Running tool calls...'));

  for (const call of toolCalls) {
    const name = call.function.name;
    const args = call.function.arguments;
    const handler = toolHandlers[name];
    const describe = toolDescribers[name];

    console.log(
      chalk.blueBright(`  [>] ${describe ? describe(args as Record<string, unknown>, chalk) : `calling ${chalk.yellow(name)}`}`)
    );

    let output: unknown;
    if (!handler) {
      output = `Error: unknown tool "${name}"`;
      console.error(chalk.red(`  [x] No handler registered for tool "${name}"`));
    } else {
      try {
        output = await handler(args as Record<string, unknown>, signal);
      } catch (err) {
        if (signal && signal.aborted) {
          // The user cancelled the task via Ctrl+C. Report it back to the
          // model so it knows its work was interrupted, but don't crash.
          console.log(chalk.yellow(`  [▲] Task "${name}" cancelled by user.`));
          output = `Task cancelled by user (Ctrl+C). The ${name} operation was interrupted and did not complete.`;
        } else {
          // Tool modules are expected to catch their own errors and return a
          // string; this covers anything that slips through (e.g. a bug
          // in the handler itself, or a rejected promise it didn't await).
          logDetailedError(`Unexpected error running tool "${name}"`, err, { args });
          output = `Unexpected error running tool "${name}": ${(err as Error).message}`;
        }
      }
    }

    results.push({
      role: 'tool',
      tool_call_id: call.id,
      content: typeof output === 'string' ? output : JSON.stringify(output),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Turn / exchange / agent loop
// ---------------------------------------------------------------------------

/**
 * Sends the current history to the model, streams its reply, and reports
 * what happened. Does NOT recurse on tool calls itself — the caller
 * (runSingleExchange or runAgentLoop) decides whether/how to continue,
 * so every round is visible to a step budget.
 *
 * Cancellation: sets `currentAbortController` for the duration of the
 * request so a SIGINT handler elsewhere can abort just this generation.
 * An abort is reported back as `{ aborted: true }`, distinct from a
 * genuine stream/parse error.
 *
 * @param retriesLeft - How many more times we'll auto-retry after
 *   a malformed tool-call/stream parse error before giving up.
 */
async function runTurn(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  retriesLeft = 2
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean }> {
  process.stdout.write(chalk.magenta('model › '));

  let assistantContent = '';
  let toolCalls: ToolCall[] = [];

  const abortController = new AbortController();
  currentAbortController = abortController;

  let response: OllamaStreamResponse | AsyncGenerator<StreamChunk>;

  try {
    response = await chat(model, history, toolSchemas, think, abortController);
  } catch (err) {
    currentAbortController = null;
    process.stdout.write('\n');

    if (abortController.signal.aborted) {
      console.log(chalk.yellow('[▲] Generation cancelled.'));
      return { done: false, aborted: true };
    }

    logDetailedError('Failed to start chat request', err);
    return { done: false, failed: true };
  }

  let streamError: unknown = null;
  let aborted = false;

  // If Ctrl+C is pressed, immediately abort the underlying stream.
  //
  // FIX: previously this tried to *register a new* "abort" listener on
  // abortController.signal from inside the abort handler itself. Since
  // the signal has already fired by the time this callback runs, any
  // listener added here would never be invoked (AbortSignal ignores
  // listeners added after it has already fired) — so response.abort()
  // was never actually called, and Ctrl+C did nothing.
  //
  // The real abort-forwarding is already wired up once, up front, inside
  // chat() (see the addEventListener call there). All this handler needs
  // to do is flip the local `aborted` flag; the abortController.abort()
  // call below (triggered by the SIGINT handler) will fire that listener
  // and call response.abort() for us. For the OpenRouter path, abort() is
  // handled natively via the fetch `signal` option, so nothing extra is
  // needed there either.
  const onAbort = () => {
    aborted = true;
  };

  abortController.signal.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const part of response) {
      if (abortController.signal.aborted) {
        break;
      }
      if (part.message.thinking) {
        process.stdout.write(chalk.gray(part.message.thinking));
      }

      if (part.message.content) {
        process.stdout.write(chalk.white(part.message.content));
        assistantContent += part.message.content;
      }

      if (part.message.tool_calls?.length) {
        toolCalls.push(...part.message.tool_calls);
      }
    }
  } catch (err) {
    if (aborted || abortController.signal.aborted || (err as Error)?.name === 'AbortError') {
      aborted = true;
    } else {
      streamError = err;
      process.stdout.write('\n');
      logDetailedError('Error while streaming model response', err, {
        assistantContentSoFar: assistantContent,
      });
    }
  } finally {
    abortController.signal.removeEventListener('abort', onAbort);
    currentAbortController = null;
  }

  process.stdout.write('\n');

  if (!aborted) {
    history.push({
      role: 'assistant',
      content: assistantContent,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }

  if (aborted) {
    console.log(chalk.yellow('[▲] Generation cancelled by user.'));
    return { done: false, aborted: true };
  }

  if (streamError) {
    if (retriesLeft <= 0) {
      console.error(chalk.red('[x] Giving up after repeated malformed responses from the model.'));
      return { done: false };
    }

    console.log(
      chalk.gray(
        `  ↺ Asking the model to retry (${retriesLeft} retr${retriesLeft === 1 ? 'y' : 'ies'} left)...`
      )
    );

    history.push({
      role: 'user',
      content: [
        'Your previous response could not be parsed due to a syntax error in a tool call',
        `${(streamError as Error).message}.`,
        'Please try again. If you need to call a tool, use the standard JSON tool-call format with correctly closed braces/brackets.',
        'If you do not need a tool, just answer in plain text.',
      ].join(' '),
    });

    return runTurn(model, think, history, retriesLeft - 1);
  }

  if (toolCalls.length) {
    const completionCall = toolCalls.find((c) => c.function.name === 'task_complete');

    const taskAbortController = new AbortController();
    currentTaskAbortController = taskAbortController;

    let toolResults: ChatMessage[];
    try {
      toolResults = await runToolCalls(toolCalls, taskAbortController.signal);
    } finally {
      currentTaskAbortController = null;
    }

    history.push(...toolResults);

    if (completionCall) {
      const summary =
        completionCall.function.arguments && (completionCall.function.arguments as Record<string, unknown>).summary;

      console.log(chalk.green(`\n[✓] Task complete: ${summary || '(no summary provided)'}`));

      return { done: true, summary: summary as string | undefined };
    }

    return { done: false, moreWork: true };
  }

  return { done: false };
}

/**
 * Runs a single user turn to completion for normal (non-autonomous) chat:
 * keeps calling runTurn as long as it reports moreWork, with its own
 * internal cap so a single message can't loop forever either.
 */
async function runSingleExchange(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  maxRounds = 1000
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean } | undefined> {
  for (let round = 0; round < maxRounds; round++) {
    const result = await runTurn(model, think, history);
    if (!result || !result.moreWork) {
      return result;
    }
  }
  console.log(chalk.yellow(`[▲] Stopped after ${maxRounds} tool-call rounds in a single exchange.`));
  return { done: false, stoppedOnBudget: true };
}

/**
 * Runs an autonomous, multi-step task: repeatedly calls runTurn until the
 * model signals completion (via the task_complete tool) or the step budget
 * runs out. Unlike normal chat, this doesn't wait for user input between
 * turns — it keeps going as long as the model keeps working.
 *
 * Between tool-call rounds (i.e. whenever a turn returns `moreWork`), the
 * loop just calls runTurn again — it does NOT re-push the user's original
 * request or any synthetic message, since the freshly appended tool
 * results already give the model everything it needs to continue. A
 * "please continue" nudge is only pushed when the model hands control back
 * to the user without finishing (no tool calls AND no task_complete) —
 * i.e. it stopped generating on its own mid-task, not between tool calls.
 *
 * @param model
 * @param think - Thinking effort ('low'|'medium'|'high') or false.
 * @param history - conversation history, already seeded with the goal.
 * @param goal - the autonomous task's goal, used in the "keep going" nudge.
 * @param maxSteps - hard cap on top-level turns, to avoid runaway loops.
 */
async function runAgentLoop(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  goal: string,
  maxSteps = 1000
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean } | undefined> {
  console.log(chalk.gray(`\n[>] Starting autonomous run (max ${maxSteps} steps). Ctrl+C cancels the current step.\n`));

  for (let step = 1; step <= maxSteps; step++) {
    console.log(chalk.gray(`--- step ${step}/${maxSteps} ---`));

    let result:
      | { done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean }
      | undefined;
    try {
      result = await runTurn(model, think, history);
    } catch (err) {
      logDetailedError('Unhandled error during autonomous step', err);
      break;
    }

    if (result && (result.done || result.failed || result.aborted)) {
      return result;
    }

    if (result && result.moreWork) {
      // Tool calls just ran and their results are already in history.
      // Loop straight back into another runTurn — nothing to inject.
      continue;
    }

    // The model produced no tool calls and didn't call task_complete: it
    // paused with plain text (e.g. "Next I'll..." or an unprompted
    // question) and effectively handed control back without finishing.
    // Nudge it forward rather than silently ending the run.
    history.push({
      role: 'user',
      content: [
        `Keep working on the goal: ${goal} — autonomously, do not wait for further input from me.`,
        'Continue working on the task using the available tools.',
        'Call task_complete once it is fully finished, or if you are stuck, explain why and call task_complete anyway.',
      ].join(' '),
    });
  }

  console.log(chalk.yellow(`\n[▲] Stopped after ${maxSteps} steps without the model calling task_complete.`));
  console.log(chalk.yellow('  The task may be unfinished, stuck in a loop, or the model forgot to signal completion.'));
  return { done: false, stoppedOnBudget: true };
}

// ---------------------------------------------------------------------------
// Interactive session
// ---------------------------------------------------------------------------

/**
 * Starts an interactive chat session with the given model.
 *
 * @param model - The model name to chat with.
 * @param think - Thinking effort ('low'|'medium'|'high') or false.
 * @param provider - Which backend to use ('ollama' | 'openrouter').
 */
async function chatHandoff(model: string, think: string | boolean, provider: 'ollama' | 'openrouter'): Promise<void> {
  globalProvider = provider;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('you › '),
  });

  // Register the interface so interactive tools (e.g. `clarify`) can pause
  // it while reading their own input, then resume it afterwards.
  setActiveReadline(rl);

  const history: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }];

  console.log(chalk.gray(`\nChatting with ${model}. Type /exit or Ctrl+C to quit.`));
  console.log(chalk.gray(`Tools available: ${toolNames.join(', ')}.`));
  console.log(chalk.gray('Type /task <description> to run a multi-step task autonomously.'));
  console.log(chalk.gray('Press Ctrl+C while the model is responding to cancel that generation, or while'));
  console.log(chalk.gray('it is running a task (e.g. a shell command) to cancel that task; press it again'));
  console.log(chalk.gray('with nothing running to exit.\n'));
  rl.prompt();

  // Ctrl+C handling:
  //  - If an interactive tool (e.g. clarify) currently owns stdin for its
  //    own input read, do nothing here at all — that tool is solely
  //    responsible for handling Ctrl+C itself. See the big note below for
  //    why this check has to come first, before anything else.
  //  - If a model generation is in flight, cancel just that (via
  //    AbortController) and leave the session running.
  //  - Else if the model is running a task (e.g. a shell command), cancel
  //    that task (via currentTaskAbortController) and leave the session
  //    running. This makes Ctrl+C cancel the model's work, not just its
  //    output stream.
  //  - Else (nothing running), require a second Ctrl+C within 1s to exit,
  //    so an accidental tap doesn't kill the whole session.
  //
  // IMPORTANT: this deliberately does NOT rely solely on `process.on('SIGINT')`
  // or `rl.on('SIGINT')`. When readline owns a TTY input stream, Ctrl+C is
  // consumed by readline's own key-handling and only surfaces as a real
  // SIGINT (or an 'SIGINT' event on the interface) while that interface is
  // actively reading — i.e. NOT while it's paused. Since we call
  // `rl.pause()` for the entire duration of a generation/task (exactly the
  // moments we need to catch Ctrl+C), neither of those handlers reliably
  // fires — this is a documented Node behavior, not a bug in this file.
  //
  // The fix is `readline.emitKeypressEvents(process.stdin)` plus a
  // 'keypress' listener (registered further below): keypress events fire
  // regardless of whether `rl` is currently paused, giving us Ctrl+C
  // detection during a generation or running tool without needing `rl` to
  // be actively reading.
  //
  // We do NOT call `process.stdin.setRawMode()` ourselves anywhere in this
  // file. `readline.Interface` already manages raw mode internally for TTY
  // input on every platform, including while `rl.question()` (used by
  // clarify's readLineInteractive) is outstanding. An earlier version of
  // this file called `setRawMode(true)` manually after the
  // `readline.Interface` was already constructed — that redundant,
  // competing raw-mode application corrupted stdin's read state badly
  // enough on Windows consoles that no keystrokes were delivered to
  // anything at all (not even to a plain `rl.question()` prompt). Letting
  // `readline` be the sole owner of raw mode fixes that.
  //
  // BUG FIX (exit-to-shell during clarify): tools like `clarify` also read
  // from the shared readline interface directly (see
  // tools/user_input.ts's readLineInteractive), while this file's own
  // Ctrl+C detection is also live. Previously (with the old raw-byte
  // approach) both could react to the same Ctrl+C keystroke independently:
  // the tool would treat it as "cancel clarification" while this handler
  // would simultaneously treat it as a task-cancel or (on a second
  // stray/overlap) as the "nothing running -> exit" case, which could call
  // process.exit(0) out from under what looked like normal clarify usage.
  // The fix is `isInterruptSuppressed()`: interactive readers set that flag
  // for the duration of their own read, and this handler defers to them
  // completely — it must not abort anything or advance the exit state
  // while it's set, since it means someone else already owns this
  // keystroke.
  let exiting = false;

  const handleInterrupt = () => {
    // An interactive tool (e.g. clarify) currently owns stdin and is
    // handling Ctrl+C itself. Do not act on it here at all.
    if (isInterruptSuppressed()) {
      return;
    }

    // Cancel model generation
    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      return;
    }

    // Cancel running tool
    if (currentTaskAbortController && !currentTaskAbortController.signal.aborted) {
      currentTaskAbortController.abort();
      return;
    }

    // Nothing running -> double Ctrl+C exits
    if (exiting) {
      process.exit(0);
    }

    exiting = true;
    console.log(chalk.gray('\n(Press Ctrl+C again to exit.)'));

    setTimeout(() => {
      exiting = false;
    }, 1000);
  };

  // Ctrl+C detection, without owning raw mode ourselves.
  //
  // ROOT CAUSE OF "nothing can be typed": this file used to call
  // `process.stdin.setRawMode(true)` manually, *after* `readline.createInterface`
  // had already been constructed on `process.stdin`. `readline.Interface`
  // manages raw mode internally for TTY input (that's how it supports
  // arrow keys, history, backspace, etc., and how `rl.question()` reads
  // an answer) — calling `setRawMode(true)` again on top of that is a
  // redundant, competing raw-mode application on the same stream. POSIX
  // ptys mostly tolerate this; Windows' console backend does not, and the
  // stream's read state ends up broken badly enough that no further
  // keystrokes are delivered anywhere — which is exactly the "nothing
  // gets typed, Enter and Ctrl+C do nothing" symptom.
  //
  // The fix: never call `setRawMode` ourselves. `readline` already
  // decides when process.stdin needs raw mode and manages it correctly on
  // every platform, including while a `question()` (used by
  // readLineInteractive/clarify) is outstanding.
  //
  // What we still need from the old approach is a way to catch Ctrl+C
  // even while `rl` itself is paused (during a model generation or a
  // running tool) — `rl.on('SIGINT', ...)` alone does not fire while `rl`
  // is paused. `readline.emitKeypressEvents(stdin)` gives us that: it
  // turns on keypress parsing for the stream (the same parsing `readline`
  // itself relies on and is safe to call alongside an existing
  // `readline.Interface` — it's idempotent per-stream), and the resulting
  // 'keypress' events fire regardless of whether `rl` is currently paused,
  // without us ever touching raw-mode state directly.
  readline.emitKeypressEvents(process.stdin);

  const onKeypress = (_str: string, key: { sequence?: string } | undefined) => {
    if (key?.sequence === '\u0003') {
      // Guard here too (not just inside handleInterrupt) so we don't even
      // enter the interrupt-handling path while an interactive tool read
      // owns stdin. Belt-and-suspenders with the check inside
      // handleInterrupt, which also guards the rl.on('SIGINT', ...)
      // fallback path below.
      if (isInterruptSuppressed()) {
        return;
      }
      handleInterrupt();
    }
  };

  process.stdin.on('keypress', onKeypress);

  // Still register the standard handlers too, as a fallback for
  // non-TTY environments (piped input, some CI/test runners) where
  // keypress events aren't emitted and normal SIGINT delivery is
  // unaffected by readline's pause state. handleInterrupt() itself checks
  // isInterruptSuppressed(), so this fallback path is also safe while an
  // interactive tool read is in progress.
  process.on('SIGINT', handleInterrupt);
  rl.on('SIGINT', handleInterrupt);

  rl.on('line', async (line: string) => {
    // Defense in depth: an interactive tool read (e.g. clarify, via
    // readLineInteractive) may currently be reading raw bytes directly
    // off stdin for its own prompt. We no longer pause/resume `rl` around
    // those reads (doing so caused a silent process exit on Windows
    // consoles — see the comments in tools/user_input.ts), so it's
    // possible in principle for readline's own line-buffering to also
    // observe some of those same bytes on certain platforms/terminals.
    // If that happens, ignore it here rather than treating it as a new
    // top-level chat message — the interactive reader is the sole
    // intended consumer of that input while it owns the prompt.
    if (isInterruptSuppressed()) {
      return;
    }

    const input = line.trim();

    if (input === '') {
      rl.prompt();
      return;
    }

    if (input === '/exit' || input === '/quit') {
      rl.close();
      return;
    }

    try {
      if (input.startsWith('/task ')) {
        const goal = input.slice('/task '.length).trim();

        if (!goal) {
          console.log(chalk.yellow('Usage: /task <description of what you want done>'));
        } else {
          history.push({
            role: 'user',
            content: [
              `Task: ${goal}`,
              '',
              'Work through this autonomously using the available tools, without asking me for input.',
              'Do not stop to check in or ask permission for routine steps — only pause if you are genuinely blocked.',
              'When the task is fully complete, call task_complete with a concise summary of what you did.',
              'If you get stuck or cannot proceed, explain why and call task_complete anyway with what you were able to accomplish.',
            ].join('\n'),
          });

          await runAgentLoop(model, think, history, goal);
        }
      } else {
        history.push({ role: 'user', content: input });
        await runSingleExchange(model, think, history);
      }
    } catch (err) {
      logDetailedError('Unhandled error during chat turn', err);
    }

    process.stdout.write('\n');

    rl.resume();
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.removeListener('SIGINT', handleInterrupt);
      rl.removeListener('SIGINT', handleInterrupt);
      console.log(chalk.gray('\nChat ended.'));
      resolve();
    });
  });
}

export { chatHandoff };