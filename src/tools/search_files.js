const fs = require('fs/promises');
const path = require('path');
const { formatToolError, walkFiles, globToRegExp } = require('./utils');

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern within files under a directory (like grep), returning matching file paths, line numbers, and lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text or regular expression to search for.',
          },
          directory: {
            type: 'string',
            description: 'Directory to search under. Defaults to the current working directory.',
          },
          file_glob: {
            type: 'string',
            description: 'Optional glob to restrict which files are searched, e.g. "*.js".',
          },
        },
        required: ['pattern'],
      },
    },
  },

  async handler(args) {
    const directory = args.directory || '.';
    const maxMatches = 200;

    try {
      let files = await walkFiles(directory);

      if (args.file_glob) {
        const re = globToRegExp(args.file_glob);
        files = files.filter((f) => re.test(path.basename(f)));
      }

      let pattern;
      try {
        pattern = new RegExp(args.pattern);
      } catch {
        pattern = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }

      const matches = [];

      for (const file of files) {
        if (matches.length >= maxMatches) break;
        const full = path.join(directory, file);
        let content;
        try {
          content = await fs.readFile(full, 'utf-8');
        } catch {
          continue; // skip binary/unreadable files
        }

        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (matches.length >= maxMatches) return;
          if (pattern.test(line)) {
            matches.push({ file, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }

      return JSON.stringify(matches, null, 2);
    } catch (err) {
      return formatToolError('Error searching files', err);
    }
  },

  describe(args, chalk) {
    return `searching for ${chalk.yellow(args.pattern)} in ${chalk.yellow(args.directory || '.')}`;
  },
};