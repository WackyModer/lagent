import fs from 'fs';
import path from 'path';
import type { ToolModule, LoadedTools } from '../types/common';

const EXCLUDE_FILES = new Set(['index.js', 'index.ts', 'utils.js', 'utils.ts']);

/**
 * Auto-discovers every tool module in this directory (any .js/.ts file other
 * than index/utils). Each tool module must export (via `export =`):
 *   {
 *     schema: {...},              // OpenAI/Ollama-style function schema
 *     handler: async (args) => {},// returns a string (or JSON-stringifiable value)
 *     describe: (args, chalk) => '' // short human-readable description for console output
 *   }
 *
 * To add a new tool: create tools/my_tool.js (or .ts) exporting that shape.
 * No other files need to change.
 */
function loadTools(): LoadedTools {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => (f.endsWith('.js') || f.endsWith('.ts')) && !EXCLUDE_FILES.has(f));

  const schemas = [];
  const handlers: Record<string, ToolModule['handler']> = {};
  const describers: Record<string, ToolModule['describe']> = {};
  const names: string[] = [];

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(__dirname, file)) as ToolModule;

    if (!mod || !mod.schema || !mod.handler) {
      console.warn(`[tools] Skipping ${file}: missing "schema" or "handler" export.`);
      continue;
    }

    const name = mod.schema.function && mod.schema.function.name;
    if (!name) {
      console.warn(`[tools] Skipping ${file}: schema.function.name is missing.`);
      continue;
    }

    schemas.push(mod.schema);
    handlers[name] = mod.handler;
    describers[name] = mod.describe || ((args, c) => `calling ${c.yellow(name)}`);
    names.push(name);
  }

  return { schemas, handlers, describers, names };
}

const loaded: LoadedTools = loadTools();

export const schemas = loaded.schemas;
export const handlers = loaded.handlers;
export const describers = loaded.describers;
export const names = loaded.names;
