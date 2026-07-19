const fs = require('fs/promises');
const { formatToolError } = require('./utils');

function normalizeNewlines(str) {
  return str.replace(/\r\n|\r/g, '\n');
}

module.exports = {
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

  async handler(args) {
    try {
      const rawContent = await fs.readFile(args.path, 'utf-8');

      // Detect original line-ending style so we can restore it on write.
      const usesCRLF = /\r\n/.test(rawContent);

      const content = normalizeNewlines(rawContent);
      const oldText = normalizeNewlines(args.old_text);
      const newText = normalizeNewlines(args.new_text);

      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        return `Error: old_text not found in ${args.path}`;
      }
      if (occurrences > 1) {
        return `Error: old_text matches ${occurrences} times in ${args.path}; it must be unique. Include more surrounding context.`;
      }

      let updated = content.replace(oldText, newText);

      // Restore original line-ending convention.
      if (usesCRLF) {
        updated = updated.replace(/\n/g, '\r\n');
      }

      await fs.writeFile(args.path, updated, 'utf-8');
      return `Edited ${args.path} (1 replacement)`;
    } catch (err) {
      return formatToolError('Error editing file', err);
    }
  },

  describe(args, chalk) {
    return `editing ${chalk.yellow(args.path)}`;
  },
};