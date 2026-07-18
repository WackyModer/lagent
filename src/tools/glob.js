const { formatToolError, walkFiles, globToRegExp } = require('./utils');

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern (e.g. "**/*.js", "src/**/*.json") under a directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files against, relative to the search directory.',
          },
          directory: {
            type: 'string',
            description: 'Directory to search under. Defaults to the current working directory.',
          },
        },
        required: ['pattern'],
      },
    },
  },

  async handler(args) {
    const directory = args.directory || '.';
    try {
      const files = await walkFiles(directory);
      const re = globToRegExp(args.pattern);
      const matched = files.filter((f) => re.test(f));
      return JSON.stringify(matched, null, 2);
    } catch (err) {
      return formatToolError('Error matching glob', err);
    }
  },

  describe(args, chalk) {
    return `matching ${chalk.yellow(args.pattern)} in ${chalk.yellow(args.directory || '.')}`;
  },
};