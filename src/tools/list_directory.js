const fs = require('fs/promises');
const path = require('path');
const { formatToolError } = require('./utils');

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory, including whether each entry is a file or directory and its size in bytes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the directory to list (relative or absolute). Defaults to the current working directory.',
          },
        },
        required: [],
      },
    },
  },

  async handler(args) {
    const dirPath = args.path || '.';
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const results = await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            return { name: entry.name, type: 'directory' };
          }
          const stat = await fs.stat(full);
          return { name: entry.name, type: 'file', size: stat.size };
        })
      );
      return JSON.stringify(results, null, 2);
    } catch (err) {
      return formatToolError('Error listing directory', err);
    }
  },

  describe(args, chalk) {
    return `listing ${chalk.yellow(args.path || '.')}`;
  },
};