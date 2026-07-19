import fs from 'fs/promises';
import chalk from 'chalk';
import { formatToolError } from './utils';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
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

  async handler(args: Record<string, unknown>) {
    const filePath = args.path as string;
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      return formatToolError('Error reading file', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `reading ${chalk.yellow(args.path as string)}`;
  },
};

export = tool;
