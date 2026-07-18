const fs = require('fs/promises');
const path = require('path');
const { formatToolError } = require('./utils');

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating it if it does not exist or overwriting it if it does. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write (relative or absolute).',
          },
          content: {
            type: 'string',
            description: 'The full content to write to the file.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },

  async handler(args) {
    try {
      await fs.mkdir(path.dirname(args.path), { recursive: true });
      await fs.writeFile(args.path, args.content, 'utf-8');
      return `Wrote ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${args.path}`;
    } catch (err) {
      return formatToolError('Error writing file', err);
    }
  },

  describe(args, chalk) {
    return `writing ${chalk.yellow(args.path)}`;
  },
};