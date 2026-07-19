import chalk from 'chalk';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Call this when the requested task is fully finished and no further steps are needed. This ends the current run. Do not call it if there is more work left to do.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A brief summary of what was accomplished.',
          },
        },
        required: ['summary'],
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    return `Task marked complete: ${args.summary}`;
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `marking task complete: ${chalk.yellow(args.summary as string)}`;
  },
};

export = tool;
