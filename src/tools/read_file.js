const fs = require('fs/promises');
const { formatToolError } = require('./utils');

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the local filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read (relative or absolute).',
          },
        },
        required: ['path'],
      },
    },
  },

  async handler(args) {
    try {
      return await fs.readFile(args.path, 'utf-8');
    } catch (err) {
      return formatToolError('Error reading file', err);
    }
  },

  describe(args, chalk) {
    return `reading ${chalk.yellow(args.path)}`;
  },
};