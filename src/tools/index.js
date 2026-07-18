const fs = require('fs');
const path = require('path');

const EXCLUDE_FILES = new Set(['index.js', 'utils.js']);

/**
 * Auto-discovers every tool module in this directory (any .js file other
 * than index.js/utils.js). Each tool module must export:
 *   {
 *     schema: {...},              // OpenAI/Ollama-style function schema
 *     handler: async (args) => {},// returns a string (or JSON-stringifiable value)
 *     describe: (args, chalk) => '' // short human-readable description for console output
 *   }
 *
 * To add a new tool: create tools/my_tool.js exporting that shape.
 * No other files need to change.
 */
function loadTools() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && !EXCLUDE_FILES.has(f));

  const schemas = [];
  const handlers = {};
  const describers = {};
  const names = [];

  for (const file of files) {
    const mod = require(path.join(__dirname, file));

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
    describers[name] = mod.describe || ((args, chalk) => `calling ${chalk.yellow(name)}`);
    names.push(name);
  }

  return { schemas, handlers, describers, names };
}

module.exports = loadTools();