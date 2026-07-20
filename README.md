# LAgent

**A lightweight, agentic AI tool focused on programming.**

LAgent is a command-line AI coding companion. You chat with a language model
that can read and write files, run shell commands, search your codebase, and
fetch from the web — all on your local machine. It supports both interactive
chat and a fully autonomous task mode, and works with either locally hosted
[Ollama](https://ollama.com) models or cloud models through
[OpenRouter](https://openrouter.ai).

## Features

- **Two interaction modes**
  - _Normal chat_: you type a message, the model replies (and may use tools),
    and you stay in control.
  - _Autonomous task mode_: you give it a goal with `/task`, and it works
    through it end-to-end using tools without prompting you between steps.
- **Streaming responses** with visible chain-of-thought ("thinking") when the
  model supports it.
- **Two backends**: pick Ollama (local, private) or OpenRouter (cloud) at
  startup.
- **Interruptible**: press `Ctrl+C` while the model is generating to cancel
  that generation, or while a tool (e.g. a shell command) is running to cancel
  that task. Press it again when nothing is running to exit.
- **Extensible**: tools are auto-discovered at runtime — drop a new file into
  `src/tools/` and it is available immediately, no registration needed.
- **Runs anywhere Node.js does**, including Windows, macOS, and Linux.

## Requirements

- [Node.js](https://nodejs.org) (this project targets Node `>= 24`; uses ES2022).
- [Ollama](https://ollama.com) installed and running locally (only needed if you
  use the `ollama` provider), **or** an OpenRouter API key (only needed if you
  use the `openrouter` provider).

## Installation

```bash
# Clone / download the repository, then from the project root:
npm install      # install dependencies
npm run build    # compile TypeScript to ./dist
```

## Configuration

Copy the example environment file and fill in the values you need:

```bash
cp .env.example .env
```

| Variable             | Required for      | Description                                                            |
| -------------------- | ----------------- | ---------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | `openrouter`      | Your OpenRouter API key (e.g. `sk-or-v1-...`).                         |
| `OLLAMA_HOST`        | `ollama`          | Base URL of your Ollama server. Defaults to `http://localhost:11434`.  |

The file is loaded from a `.env` at the project root (and is git-ignored).
You only need the variable for whichever provider you plan to use.

## Usage

Run the compiled CLI:

```bash
npm start
# or directly:
node ./dist/bin/lagent.js
```

On startup you will be prompted to:

1. **Choose a provider** — `ollama` or `openrouter`.
   - If you pick **ollama**, you then pick a model from the list of models
     Ollama has pulled, and — if that model supports "thinking" — a thinking
     effort of `low` / `medium` / `high`.
   - If you pick **openrouter**, you choose from a recommended model list (or
     `Enter my own` and type any OpenRouter model id, e.g.
     `google/gemma-4-31b-it:free`). Reasoning is enabled for OpenRouter by
     default (you can turn it off when entering a custom model).
2. Start chatting.

### Commands (in the chat prompt)

| Command              | Description                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| _(any text)_         | Send a message to the model in normal chat mode.                            |
| `/task <goal>`       | Run a multi-step task autonomously. The model works through it without further input from you until it finishes. |
| `/exit` or `/quit`   | End the session.                                                            |

`Ctrl+C` behavior:

- While the model is **generating** → cancels just that generation and keeps the session alive.
- While a **tool/task is running** (e.g. a shell command via `execute_command`) → cancels that task.
- While **nothing is running** → press it twice within one second to exit.

> **Note on terminals**: LAgent needs an interactive terminal (TTY) for chat
> input and clarifying questions. In a non-interactive environment (piped
> stdin, no TTY), interactive prompts are skipped gracefully rather than
> hanging.

## Tools

Tools are declared in `src/tools/*.ts` and **auto-discovered** at runtime by
`src/tools/index.ts` — every file in that directory (except `index`/`utils`)
that exports a `schema`, `handler`, and `describe` is registered automatically.
The model can call any of them. There are currently **10 tools**:

### File & filesystem

1. **`write_file`** — Write content to a file, creating it (and parent
   directories) if it does not exist, or overwriting it if it does.
   Args: `path`, `content`.

2. **`edit_file`** — Targeted find-and-replace inside an existing file. The
   `old_text` must match **exactly once** (the model is told to add more
   surrounding context if it matches multiple times). Preserves the original
   line-ending style (CRLF/LF). Args: `path`, `old_text`, `new_text`.

3. **`read_file`** — Read and return the full contents of a file as text.
   Args: `path`.

4. **`list_directory`** — List a directory's entries with each entry's type
   (file/directory) and size in bytes. Defaults to the current working
   directory. Args: `path` (optional).

### Search & discovery

5. **`glob`** — Find files matching a glob pattern
   (e.g. `"**/*.js"`, `"src/**/*.json"`) under a directory. Supports `*`,
   `**`, and `?`. Args: `pattern`, `directory` (optional).

6. **`search_files`** — Like `grep`: search a directory for a text or regex
   pattern, returning matching file paths, line numbers, and the matching
   line text. Skips `node_modules`, `.git`, `dist`, etc. by default, and
   caps at 200 matches. Args: `pattern`, `directory` (optional),
   `file_glob` (optional).

### Execution & network

7. **`execute_command`** — Run a shell command and return its `stdout`,
   `stderr`, and `exitCode` as JSON. The whole spawned process tree is
   force-killed if you cancel with `Ctrl+C`. Cross-platform (uses
   `taskkill` on Windows, process-group `SIGKILL` on POSIX). Args: `command`.

8. **`fetch_url`** — Fetch a web page or API endpoint and return its status
   and body as text (truncated to 50,000 characters). Follows redirects.
   Args: `url`.

### Control flow (used by the agent loop)

9. **`clarify`** — Pause and ask the user a clarifying question with a list of
   suggested options; the user can pick by number or type their own answer.
   Used when the model is genuinely blocked or needs a decision. Args:
   `question`, `options` (optional).

10. **`task_complete`** — Signal that the task is finished and end the current
    run. The agent loop treats this as the stop condition. Args: `summary`.

### Adding a new tool

Create `src/tools/my_tool.ts` exporting a module of this shape:

```ts
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'my_tool',
      description: 'What the tool does.',
      parameters: {
        type: 'object',
        properties: { arg: { type: 'string', description: '...' } },
        required: ['arg'],
      },
    },
  },
  async handler(args, signal) {
    // ...do work, return a string (or JSON-stringifiable value)
  },
  describe(args, c) {
    return `using my_tool: ${c.yellow(args.arg as string)}`;
  },
};

export = tool;
```

No other files need to change — it will be picked up on the next run.

## Architecture

```
bin/lagent.ts        Entry point: prompts for provider/model/effort, then hands off.
src/init.ts          Shared Ollama client + reusable interactive list prompt.
src/chat.ts          Core: provider adapters, system prompt, streaming, agent loop.
src/tools/           Auto-discovered tool modules (each exports schema+handler+describe).
src/types/common.ts  Shared TypeScript types (tools, messages, stream chunks).
```

- **Provider adapters** (`chat.ts`) normalize both Ollama and OpenRouter into a
  single Ollama-shaped async stream (`{ message, done }`), so the rest of the
  code is backend-agnostic.
- **System prompt** is generated at runtime from your environment (OS, shell,
  working directory, Node version) and includes tool-usage guidelines plus the
  autonomous-task-mode rules.
- **Agent loop**: a turn streams the model's reply; if the model requests tool
  calls, they are executed and their results are fed back; the loop continues
  until the model calls `task_complete`, nothing more is requested, or you
  interrupt. Normal chat caps exchange rounds; `/task` runs the autonomous
  loop with its own step budget.

## Development

```bash
npm run build   # compile TypeScript -> ./dist
npm start       # run the compiled CLI
npm test        # build, then run
```

Source is TypeScript (`strict` mode; Node16 modules). Build output goes to
`./dist` (git-ignored). Dependencies: `@openrouter/sdk`, `ollama`,
`@inquirer/prompts`, `enquirer`, `chalk`, `dotenv`.

## License

[GNU General Public License v3.0](./LICENSE).
