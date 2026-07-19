const readline = require('readline');
const os = require('os');
const util = require('util');
const path = require('path');
const { ollama, chalk } = require('./init.js');
const { schemas: tools, handlers: toolHandlers, describers: toolDescribers, names: toolNames } = require('./tools');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Tracks the AbortController for whatever model request is currently in
// flight, so SIGINT (Ctrl+C) can cancel just the generation instead of
// killing the whole process. Set right before a request starts and cleared
// in a `finally` once the stream ends, however it ends.
let currentAbortController = null;

// Tracks the AbortController for whatever tool/task the model is currently
// running (e.g. a shell command via execute_command). When a generation
// finishes and the model moves on to actually doing work, this is set so a
// SIGINT (Ctrl+C) can cancel the in-progress task too — not just the model
// run. Cleared once the tool batch completes, however it ends.
let currentTaskAbortController = null;

// Which backend chat() should talk to ('ollama' | 'openrouter'). Set once
// by chatHandoff() at session start.
let globalProvider = null;

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

function toOpenRouterMessages(history) {
  return history.map((msg) => {
    const out = { role: msg.role };

    out.content =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;

    if (msg.tool_calls) {
      out.tool_calls = msg.tool_calls.map((tc) => ({
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
async function chat(model, history, tools, think, abortController) {
  let response;

  if (globalProvider === 'ollama') {
    response = await ollama.chat({
      model,
      messages: history,
      think,
      tools,
      stream: true,
      options: {
        num_predict: -1, // generate until the model stops or context fills
      },
    });

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
      abortController.signal.addEventListener(
        'abort',
        () => {
          try {
            response.abort();
          } catch {}
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
      const errText = await httpResponse.text().catch(() => '');
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
async function* openRouterStreamToOllamaShape(httpResponse) {
  const reader = httpResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // Accumulate partial tool_calls across deltas, since OpenAI-style
  // streaming sends tool call arguments incrementally by index.
  const toolCallAcc = new Map(); // index -> { id, type, function: { name, arguments } }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { message: { role: 'assistant', content: '' }, done: true };
          return;
        }

        let parsed;
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
            const existing = toolCallAcc.get(idx) || {
              id: tc.id,
              type: 'function',
              function: { name: '', arguments: '' },
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            toolCallAcc.set(idx, existing);
          }
        }

        const isFinal = finishReason != null;

        const message = {
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
              arguments: safeParseJSON(tc.function.arguments),
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

function safeParseJSON(str) {
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
function logDetailedError(context, err, extra = {}) {
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
      const extraProps = {};
      for (const k of extraKeys) extraProps[k] = err[k];
      console.error(chalk.red(`  details: ${util.inspect(extraProps, { depth: 4 })}`));
    }

    if (err.stack) {
      console.error(chalk.gray(`  stack:\n${err.stack.split('\n').map((l) => '    ' + l).join('\n')}`));
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
function buildSystemPrompt() {
  const platform = os.platform(); // 'win32', 'linux', 'darwin'
  const shell = platform === 'win32' ? 'cmd.exe / PowerShell' : (process.env.SHELL || 'sh');

  return [
    'You are an AI assistant with access to tools that can read files and execute shell commands on the user\'s machine.',
    'You operate in two modes: normal chat, where you respond to one user message at a time and should stop and',
    'ask when something is ambiguous or risky, and autonomous task mode (triggered by the user via /task), where you',
    'work through a goal end-to-end across multiple tool calls without waiting for user input between steps.',
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
 * @param {Array} toolCalls - The tool calls the model requested.
 * @param {AbortSignal} [signal] - Signal to cancel an in-progress task.
 */
async function runToolCalls(toolCalls, signal) {
  const results = [];
  console.log(chalk.blue('[>] Running tool calls...'));

  for (const call of toolCalls) {
    const name = call.function.name;
    const args = call.function.arguments;
    const handler = toolHandlers[name];
    const describe = toolDescribers[name];

    console.log(chalk.blueBright(`  [>] ${describe ? describe(args, chalk) : `calling ${chalk.yellow(name)}`}`));

    let output;
    if (!handler) {
      output = `Error: unknown tool "${name}"`;
      console.error(chalk.red(`  [x] No handler registered for tool "${name}"`));
    } else {
      try {
        output = await handler(args, signal);
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
          output = `Unexpected error running tool "${name}": ${err.message}`;
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
 * @param {number} retriesLeft - How many more times we'll auto-retry after
 *   a malformed tool-call/stream parse error before giving up.
 */
async function runTurn(model, think, history, retriesLeft = 2) {
  process.stdout.write(chalk.magenta('model › '));

  let assistantContent = '';
  let toolCalls = [];

  const abortController = new AbortController();
  currentAbortController = abortController;

  let response;

  try {
    response = await chat(model, history, tools, think, abortController);
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

  let streamError = null;
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
    if (aborted || abortController.signal.aborted || err?.name === 'AbortError') {
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
        `(${streamError.message}).`,
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

    let toolResults;
    try {
      toolResults = await runToolCalls(toolCalls, taskAbortController.signal);
    } finally {
      currentTaskAbortController = null;
    }

    history.push(...toolResults);

    if (completionCall) {
      const summary = completionCall.function.arguments && completionCall.function.arguments.summary;

      console.log(chalk.green(`\n[✓] Task complete: ${summary || '(no summary provided)'}`));

      return { done: true, summary };
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
async function runSingleExchange(model, think, history, maxRounds = 1000) {
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
 * @param {string} model
 * @param {string|boolean} think
 * @param {Array} history - conversation history, already seeded with the goal.
 * @param {string} goal - the autonomous task's goal, used in the "keep going" nudge.
 * @param {number} maxSteps - hard cap on top-level turns, to avoid runaway loops.
 */
async function runAgentLoop(model, think, history, goal, maxSteps = 1000) {
  console.log(chalk.gray(`\n[>] Starting autonomous run (max ${maxSteps} steps). Ctrl+C cancels the current step.\n`));

  for (let step = 1; step <= maxSteps; step++) {
    console.log(chalk.gray(`--- step ${step}/${maxSteps} ---`));

    let result;
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
 * @param {string} model - The model name to chat with.
 * @param {string|boolean} think - Thinking effort ('low'|'medium'|'high') or false.
 * @param {string} provider - Which backend to use ('ollama' | 'openrouter').
 */
async function chatHandoff(model, think, provider) {
  globalProvider = provider;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('you › '),
  });

  const history = [{ role: 'system', content: buildSystemPrompt() }];

  console.log(chalk.gray(`\nChatting with ${model}. Type /exit or Ctrl+C to quit.`));
  console.log(chalk.gray(`Tools available: ${toolNames.join(', ')}.`));
  console.log(chalk.gray('Type /task <description> to run a multi-step task autonomously.'));
  console.log(chalk.gray('Press Ctrl+C while the model is responding to cancel that generation, or while'));
  console.log(chalk.gray('it is running a task (e.g. a shell command) to cancel that task; press it again'));
  console.log(chalk.gray('with nothing running to exit.\n'));
  rl.prompt();

  // Ctrl+C handling:
  //  - If a model generation is in flight, cancel just that (via
  //    AbortController) and leave the session running.
  //  - Else if the model is running a task (e.g. a shell command), cancel
  //    that task (via currentTaskAbortController) and leave the session
  //    running. This makes Ctrl+C cancel the model's work, not just its
  //    output stream.
  //  - Else (nothing running), require a second Ctrl+C within 1s to exit,
  //    so an accidental tap doesn't kill the whole session.
  //
  // IMPORTANT: this deliberately does NOT rely on `process.on('SIGINT')` or
  // `rl.on('SIGINT')`. When readline owns a TTY input stream, Ctrl+C is
  // consumed by readline's own key-handling and only surfaces as a real
  // SIGINT (or an 'SIGINT' event on the interface) while that interface is
  // actively reading — i.e. NOT while it's paused. Since we call
  // `rl.pause()` for the entire duration of a generation/task (exactly the
  // moments we need to catch Ctrl+C), neither of those handlers reliably
  // fires — this is a documented Node behavior, not a bug in this file.
  //
  // The fix is to put stdin into raw mode ourselves and read the Ctrl+C
  // byte (0x03) directly off the stream. Raw mode + a manual 'data'
  // listener works regardless of whether readline is paused, because it's
  // listening at a lower level than readline's own line-reading logic.
  let exiting = false;

  const handleInterrupt = () => {
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

  const CTRL_C = '\u0003';
  let rawModeEnabled = false;

  const onStdinData = (chunk) => {
    // chunk may be a Buffer or string depending on encoding; check both.
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (str.includes(CTRL_C)) {
      handleInterrupt();
    }
  };

  if (process.stdin.isTTY) {
    // setRawMode lets us see Ctrl+C as raw byte 0x03 instead of the TTY
    // driver turning it into a SIGINT that gets swallowed by readline.
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  process.stdin.on('data', onStdinData);

  // Still register the standard handlers too, as a fallback for
  // non-TTY environments (piped input, some CI/test runners) where
  // setRawMode isn't available and normal SIGINT delivery is unaffected
  // by readline's pause state.
  process.on('SIGINT', handleInterrupt);
  rl.on('SIGINT', handleInterrupt);

  rl.on('line', async (line) => {
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

  return new Promise((resolve) => {
    rl.on('close', () => {
      process.stdin.removeListener('data', onStdinData);
      if (rawModeEnabled) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      process.removeListener('SIGINT', handleInterrupt);
      rl.removeListener('SIGINT', handleInterrupt);
      console.log(chalk.gray('\nChat ended.'));
      resolve();
    });
  });
}

module.exports = { chatHandoff };