const readline = require('readline');
const os = require('os');
const util = require('util');
const { ollama, chalk } = require('./init.js');
const { schemas: tools, handlers: toolHandlers, describers: toolDescribers, names: toolNames } = require('./tools');
require("dotenv").config({quiet: true});

// Tracks the AbortController for whatever model request is currently in
// flight, so SIGINT (Ctrl+C) can cancel just the generation instead of
// killing the whole process. Set right before a request starts and cleared
// in a `finally` once the stream ends, however it ends.
let currentAbortController = null;

let globalProvider = null; // Global variable to store the selected provider

function toOpenRouterMessages(history) {
  return history.map(msg => {
    const out = {
      role: msg.role,
    };

    if (typeof msg.content === "string") {
      out.content = [
        {
          type: "text",
          text: msg.content,
        },
      ];
    } else {
      out.content = msg.content;
    }

    if (msg.tool_calls)
      out.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id,
        type: tc.type || "function",
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
        },
      }));

    if (msg.tool_call_id)
      out.tool_call_id = msg.tool_call_id;

    if (msg.name)
      out.name = msg.name;

    return out;
  });
}

async function chat(model, history, tools, think, abortController) {
  let response;

  if (globalProvider === "ollama") {
    response = await ollama.chat({
      model,
      messages: history,
      think,
      tools,
      stream: true,
      options: {
        num_predict: -1, // generate until the model stops or context fills
      },
      signal: abortController.signal,
    });
  } else if (globalProvider === "openrouter") {
    const httpResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: toOpenRouterMessages(history),
        tools,
        stream: true,
        ...(think !== undefined && {
          reasoning: { enabled: think == 'true' ? true : false },
        }),
      }),
      signal: abortController.signal,
    });

    if (!httpResponse.ok || !httpResponse.body) {
      const errText = await httpResponse.text().catch(() => "");
      throw new Error(`OpenRouter request failed: ${httpResponse.status} ${errText}`);
    }

    response = openRouterStreamToOllamaShape(httpResponse);
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return response;
}

// Adapts OpenRouter's OpenAI-style SSE stream into an async generator
// that yields chunks shaped like Ollama's: { message: { role, content, tool_calls }, done }
async function* openRouterStreamToOllamaShape(httpResponse) {
  const reader = httpResponse.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Accumulate partial tool_calls across deltas, since OpenAI-style
  // streaming sends tool call arguments incrementally by index.
  const toolCallAcc = new Map(); // index -> { id, type, function: { name, arguments } }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield { message: { role: "assistant", content: "" }, done: true };
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
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            toolCallAcc.set(idx, existing);
          }
        }

        const isFinal = finishReason != null;

        const message = {
          role: delta.role || "assistant",
          content: delta.content ?? "",
        };

        // Include reasoning/thinking content if present (OpenRouter "reasoning" field)
        if (delta.reasoning) {
          message.thinking = delta.reasoning;
        }

        if (isFinal && toolCallAcc.size > 0) {
          message.tool_calls = Array.from(toolCallAcc.values()).map((tc) => ({
            id: tc.id,
            type: "function",
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

/**
 * Runs all tool calls requested by the model and returns tool result messages.
 */
async function runToolCalls(toolCalls) {
  const results = [];
  console.log(chalk.blue("[>] Running tool calls..."));
  for (const call of toolCalls) {
    const name = call.function.name;
    const args = call.function.arguments;
    const handler = toolHandlers[name];
    const describe = toolDescribers[name];
    // could use →
    console.log(chalk.blueBright(`  [>] ${describe ? describe(args, chalk) : `calling ${chalk.yellow(name)}`}`));

    let output;
    if (!handler) {
      output = `Error: unknown tool "${name}"`;
      console.error(chalk.red(`  [x] No handler registered for tool "${name}"`));
    } else {
      try {
        output = await handler(args);
      } catch (err) {
        // Tool modules are expected to catch their own errors and return a
        // string; this covers anything that slips through (e.g. a bug
        // in the handler itself, or a rejected promise it didn't await).
        logDetailedError(`Unexpected error running tool "${name}"`, err, { args });
        output = `Unexpected error running tool "${name}": ${err.message}`;
      }
    }

    // results.push({
    //   role: 'tool',
    //   content: typeof output === 'string' ? output : JSON.stringify(output),
    // });
    results.push({
        role: 'tool',
        tool_call_id: call.id,
        content: typeof output === 'string'
            ? output
            : JSON.stringify(output),
    });
  }

  return results;
}

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
    // response = await ollama.chat({
    //   model,
    //   messages: history,
    //   think,
    //   tools,
    //   stream: true,
    //   options: {
    //     num_predict: -1, // generate until the model stops or context fills
    //   },
    //   signal: abortController.signal,
    // });
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

  try {
    for await (const part of response) {
      if (abortController.signal.aborted) {
        aborted = true;
        break;
      }

      if (part.message.thinking) {
        process.stdout.write(chalk.gray(part.message.thinking));
      }

      if (part.message.content) {
        process.stdout.write(chalk.white(part.message.content));
        assistantContent += part.message.content;
      }

      if (part.message.tool_calls && part.message.tool_calls.length > 0) {
        toolCalls = toolCalls.concat(part.message.tool_calls);
      }
    }
  } catch (err) {
    if (abortController.signal.aborted || err.name === 'AbortError') {
      aborted = true;
    } else {
      streamError = err;
      process.stdout.write('\n');
      logDetailedError('Error while streaming model response', err, { assistantContentSoFar: assistantContent });
    }
  } finally {
    currentAbortController = null;
  }

  process.stdout.write('\n');

  // Record whatever partial content/tool calls we got, so the
  // conversation history stays consistent no matter how the turn ended.
  history.push({
    role: 'assistant',
    content: assistantContent,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });

  if (aborted) {
    console.log(chalk.yellow('[▲] Generation cancelled by user.'));
    return { done: false, aborted: true };
  }

  if (streamError) {
    if (retriesLeft <= 0) {
      console.error(chalk.red('[x] Giving up after repeated malformed responses from the model.'));
      return { done: false };
    }

    // The model likely emitted malformed tool-call syntax. Tell it what
    // went wrong and ask it to retry with valid JSON-style tool calls,
    // rather than silently dropping the turn and losing the user's request.
    // THIS IS A UNICODE?? ↺
    console.log(chalk.gray(`  ↺ Asking the model to retry (${retriesLeft} retr${retriesLeft === 1 ? 'y' : 'ies'} left)...`));

    history.push({
      role: 'user',
      content: [
        'Your previous response could not be parsed due to a syntax error in a tool call',
        `(${streamError.message}).`,
        'Please try again. If you need to call a tool, use the standard JSON tool-call format',
        'with correctly closed braces/brackets — do not use XML-style tags.',
        'If you do not need a tool, just answer in plain text.',
      ].join(' '),
    });

    return runTurn(model, think, history, retriesLeft - 1);
  }

  if (toolCalls.length > 0) {
    // Check for task_complete before running the rest of the tools, so an
    // autonomous loop can stop immediately rather than doing another round.
    const completionCall = toolCalls.find((c) => c.function.name === 'task_complete');

    const toolResults = await runToolCalls(toolCalls);
    history.push(...toolResults);

    if (completionCall) {
      const summary = completionCall.function.arguments && completionCall.function.arguments.summary;
      console.log(chalk.green(`\n[✓] Task complete: ${summary || '(no summary provided)'}`));
      return { done: true, summary };
    }

    // Signal that more work is pending; the caller decides whether/how to
    // continue. Tool results are already in history, so the next runTurn
    // call will pick them up on its own — no synthetic user message needed.
    return { done: false, moreWork: true };
  }

  return { done: false };
}

/**
 * Runs a single user turn to completion for normal (non-autonomous) chat:
 * keeps calling runTurn as long as it reports moreWork, with its own
 * internal cap so a single message can't loop forever either.
 */
async function runSingleExchange(model, think, history, maxRounds = 20) {
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
 * @param {number} maxSteps - hard cap on top-level turns, to avoid runaway loops.
 */
async function runAgentLoop(model, think, history, goal, maxSteps = 100) {
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
        'Keep working on the goal:'+goal+' autonomously — do not wait for further input from me.',
        'Continue working on the task using the available tools.',
        'Call task_complete once it is fully finished, or if you are stuck, explain why and call task_complete anyway.',
      ].join(' '),
    });
  }

  console.log(chalk.yellow(`\n[▲] Stopped after ${maxSteps} steps without the model calling task_complete.`));
  console.log(chalk.yellow('  The task may be unfinished, stuck in a loop, or the model forgot to signal completion.'));
  return { done: false, stoppedOnBudget: true };
}

/**
 * Starts an interactive chat session with the given model.
 *
 * @param {string} model - The model name to chat with.
 * @param {string|boolean} think - Thinking effort ('low'|'medium'|'high') or false.
 */
async function chatHandoff(model, think, provider) {

  globalProvider = provider

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('you › '),
  });

  const history = [
    { role: 'system', content: buildSystemPrompt() },
  ];

  console.log(chalk.gray(`\nChatting with ${model}. Type /exit or Ctrl+C to quit.`));
  console.log(chalk.gray(`Tools available: ${toolNames.join(', ')}.`));
  console.log(chalk.gray('Type /task <description> to run a multi-step task autonomously.'));
  console.log(chalk.gray('Press Ctrl+C while the model is responding to cancel just that generation;'));
  console.log(chalk.gray('press it again with nothing running to exit.\n'));
  rl.prompt();

  // Ctrl+C handling:
  //  - If a generation is in flight, cancel just that (via AbortController)
  //    and leave the session running.
  //  - If nothing is running, require a second Ctrl+C within 1s to exit,
  //    so an accidental tap doesn't kill the whole session.
  let lastSigintAt = 0;

  const sigintHandler = () => {
    if (currentAbortController) {
      currentAbortController.abort();
      return;
    }

    const now = Date.now();
    if (now - lastSigintAt < 1000) {
      rl.close();
    } else {
      lastSigintAt = now;
      console.log(chalk.gray('\n(Press Ctrl+C again to exit.)'));
      rl.prompt();
    }
  };

  process.on('SIGINT', sigintHandler);

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

    rl.pause();

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
      process.removeListener('SIGINT', sigintHandler);
      console.log(chalk.gray('\nChat ended.'));
      resolve();
    });
  });
}

module.exports = { chatHandoff };