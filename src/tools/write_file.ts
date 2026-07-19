import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { formatToolError } from './utils';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
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

  async handler(args: Record<string, unknown>) {
    const filePath = args.path as string;
    const content = args.content as string;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${filePath}`;
    } catch (err) {
      return formatToolError('Error writing file', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `writing ${chalk.yellow(args.path as string)}`;
  },
};

export = tool;
