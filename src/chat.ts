import readline from 'readline';
import os from 'os';
import util from 'util';
import path from 'path';
import { ollama, chalk } from './init';
import type { Message } from 'ollama';
import type { ChatMessage, ToolCall, ToolSchema, StreamChunk } from './types/common';
import { schemas as toolSchemas, handlers as toolHandlers, describers as toolDescribers, names as toolNames } from './tools';
import { setActiveReadline, isInterruptSuppressed } from './tools/user_input';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

let currentAbortController: AbortController | null = null;
let currentTaskAbortController: AbortController | null = null;
let globalProvider: 'ollama' | 'openrouter' | null = null;

interface OllamaStreamResponse {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
  abort?: () => void;
}

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
        num_predict: -1,
      },
    } as unknown as Parameters<typeof ollama.chat>[0];

    response = (await ollama.chat(request)) as unknown as OllamaStreamResponse;

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
          reasoning: { enabled: think === true || think === 'true' },
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

async function* openRouterStreamToOllamaShape(httpResponse: Response): AsyncGenerator<StreamChunk> {
  const reader = httpResponse.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const toolCallAcc = new Map<number, { id?: string; type: string; function: { name: string; arguments: string } }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() as string;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          yield { message: { role: 'assistant', content: '' }, done: true };
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const finishReason = choice.finish_reason;

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
    return str;
  }
}

function logDetailedError(context: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(chalk.red(`\n[x] ${context}`));

  if (err instanceof Error) {
    console.error(chalk.red(`  name: ${err.name}`));
    console.error(chalk.red(`  message: ${err.message}`));

    if (err.cause) {
      console.error(chalk.red(`  cause: ${util.inspect(err.cause, { depth: 4 })}`));
    }

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

function buildSystemPrompt(isBench = false): string {
  const platform = os.platform();
  const shell = platform === 'win32' ? 'cmd.exe / PowerShell' : process.env.SHELL || 'sh';

  const clarifyClause = isBench
    ? 'Do not look for or rely on any interactive clarification tools.'
    : 'unless you need clarification, which you call the clarify tool for.';

  return [
    'You are an AI assistant with access to tools that can read files and execute shell commands on the user\'s machine.',
    'You operate in two modes: normal chat, where you respond to one user message at a time and should stop and',
    'ask when something is ambiguous or risky, and autonomous task mode (triggered by the user via /task), where you',
    `work through a goal end-to-end across multiple tool calls without waiting for user input between steps ${clarifyClause}`,
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
          console.log(chalk.yellow(`  [▲] Task "${name}" cancelled by user.`));
          output = `Task cancelled by user (Ctrl+C). The ${name} operation was interrupted and did not complete.`;
        } else {
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

async function runTurn(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  activeSchemas: ToolSchema[],
  retriesLeft = 2
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean }> {
  process.stdout.write(chalk.magenta('model › '));

  let assistantContent = '';
  let toolCalls: ToolCall[] = [];

  const abortController = new AbortController();
  currentAbortController = abortController;

  let response: OllamaStreamResponse | AsyncGenerator<StreamChunk>;

  try {
    response = await chat(model, history, activeSchemas, think, abortController);
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

    return runTurn(model, think, history, activeSchemas, retriesLeft - 1);
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

async function runSingleExchange(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  activeSchemas: ToolSchema[],
  maxRounds = 1000
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean } | undefined> {
  for (let round = 0; round < maxRounds; round++) {
    const result = await runTurn(model, think, history, activeSchemas);
    if (!result || !result.moreWork) {
      return result;
    }
  }
  console.log(chalk.yellow(`[▲] Stopped after ${maxRounds} tool-call rounds in a single exchange.`));
  return { done: false, stoppedOnBudget: true };
}

async function runAgentLoop(
  model: string,
  think: string | boolean,
  history: ChatMessage[],
  goal: string,
  activeSchemas: ToolSchema[],
  maxSteps = 1000
): Promise<{ done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean } | undefined> {
  console.log(chalk.gray(`\n[>] Starting autonomous run (max ${maxSteps} steps). Ctrl+C cancels the current step.\n`));

  for (let step = 1; step <= maxSteps; step++) {
    console.log(chalk.gray(`--- step ${step}/${maxSteps} ---`));

    let result:
      | { done: boolean; aborted?: boolean; failed?: boolean; moreWork?: boolean; summary?: string; stoppedOnBudget?: boolean }
      | undefined;
    try {
      result = await runTurn(model, think, history, activeSchemas);
    } catch (err) {
      logDetailedError('Unhandled error during autonomous step', err);
      break;
    }

    if (result && (result.done || result.failed || result.aborted)) {
      return result;
    }

    if (result && result.moreWork) {
      continue;
    }

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

async function chatHandoff(
  model: string,
  think: string | boolean,
  provider: 'ollama' | 'openrouter',
  initialPrompt?: string,
  isBench = false
): Promise<void> {
  globalProvider = provider;

  // Filter out 'clarify' tool schema in bench mode
  const activeSchemas = isBench
    ? toolSchemas.filter((schema) => schema.function.name !== 'clarify')
    : toolSchemas;

  const history: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(isBench) }];

  // Handle bench prompt execution
  if (initialPrompt) {
    console.log(chalk.gray(`\nRunning benchmark prompt with ${model}...`));
    console.log(chalk.cyan(`prompt › ${initialPrompt}\n`));

    if (initialPrompt.startsWith('/task ')) {
      const goal = initialPrompt.slice('/task '.length).trim();
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

      await runAgentLoop(model, think, history, goal, activeSchemas);
    } else {
      history.push({ role: 'user', content: initialPrompt });
      await runSingleExchange(model, think, history, activeSchemas);
    }

    // Benchmark completes -> exit process immediately
    if (isBench) {
      console.log(chalk.gray('\nBenchmark finished. Exiting.'));
      process.exit(0);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('you › '),
  });

  setActiveReadline(rl);

  const availableToolsList = toolNames.filter((n) => !isBench || n !== 'clarify');

  console.log(chalk.gray(`\nChatting with ${model}. Type /exit or Ctrl+C to quit.`));
  console.log(chalk.gray(`Tools available: ${availableToolsList.join(', ')}.`));
  console.log(chalk.gray('Type /task <description> to run a multi-step task autonomously.'));
  console.log(chalk.gray('Press Ctrl+C while the model is responding to cancel that generation, or while'));
  console.log(chalk.gray('it is running a task (e.g. a shell command) to cancel that task; press it again'));
  console.log(chalk.gray('with nothing running to exit.\n'));
  rl.prompt();

  let exiting = false;

  const handleInterrupt = () => {
    if (isInterruptSuppressed()) {
      return;
    }

    if (currentAbortController && !currentAbortController.signal.aborted) {
      currentAbortController.abort();
      return;
    }

    if (currentTaskAbortController && !currentTaskAbortController.signal.aborted) {
      currentTaskAbortController.abort();
      return;
    }

    if (exiting) {
      process.exit(0);
    }

    exiting = true;
    console.log(chalk.gray('\n(Press Ctrl+C again to exit.)'));

    setTimeout(() => {
      exiting = false;
    }, 1000);
  };

  readline.emitKeypressEvents(process.stdin);

  const onKeypress = (_str: string, key: { sequence?: string } | undefined) => {
    if (key?.sequence === '\u0003') {
      if (isInterruptSuppressed()) {
        return;
      }
      handleInterrupt();
    }
  };

  process.stdin.on('keypress', onKeypress);

  process.on('SIGINT', handleInterrupt);
  rl.on('SIGINT', handleInterrupt);

  rl.on('line', async (line: string) => {
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

          await runAgentLoop(model, think, history, goal, activeSchemas);
        }
      } else {
        history.push({ role: 'user', content: input });
        await runSingleExchange(model, think, history, activeSchemas);
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