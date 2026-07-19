import chalk from 'chalk';
import { formatToolError, walkFiles, globToRegExp } from './utils';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
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

  async handler(args: Record<string, unknown>) {
    const pattern = args.pattern as string;
    const directory = (args.directory as string) || '.';
    try {
      const files = await walkFiles(directory);
      const re = globToRegExp(pattern);
      const matched = files.filter((f) => re.test(f));
      return JSON.stringify(matched, null, 2);
    } catch (err) {
      return formatToolError('Error matching glob', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `matching ${chalk.yellow(args.pattern as string)} in ${chalk.yellow((args.directory as string) || '.')}`;
  },
};

export = tool;
