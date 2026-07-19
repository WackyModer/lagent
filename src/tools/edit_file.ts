import fs from 'fs/promises';
import chalk from 'chalk';
import { formatToolError } from './utils';
import type { ToolModule } from '../types/common';

function normalizeNewlines(str: string): string {
  return str.replace(/\r\n|\r/g, '\n');
}

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Perform a find-and-replace edit within an existing file. The old_text must match exactly once in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit.',
          },
          old_text: {
            type: 'string',
            description: 'The exact text to find in the file. Must be unique within the file.',
          },
          new_text: {
            type: 'string',
            description: 'The text to replace old_text with.',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    try {
      const rawContent = await fs.readFile(filePath, 'utf-8');

      // Detect original line-ending style so we can restore it on write.
      const usesCRLF = /\r\n/.test(rawContent);

      const content = normalizeNewlines(rawContent);
      const oldN = normalizeNewlines(oldText);
      const newN = normalizeNewlines(newText);

      const occurrences = content.split(oldN).length - 1;

      if (occurrences === 0) {
        return `Error: old_text not found in ${filePath}`;
      }
      if (occurrences > 1) {
        return `Error: old_text matches ${occurrences} times in ${filePath}; it must be unique. Include more surrounding context.`;
      }

      let updated = content.replace(oldN, newN);

      // Restore original line-ending convention.
      if (usesCRLF) {
        updated = updated.replace(/\n/g, '\r\n');
      }

      await fs.writeFile(filePath, updated, 'utf-8');
      return `Edited ${filePath} (1 replacement)`;
    } catch (err) {
      return formatToolError('Error editing file', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `editing ${chalk.yellow(args.path as string)}`;
  },
};

export = tool;
