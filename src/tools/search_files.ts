import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { formatToolError, walkFiles, globToRegExp } from './utils';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern within files under a directory (like grep), returning matching file paths, line numbers, and lines.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The text or regular expression to search for.',
          },
          directory: {
            type: 'string',
            description: 'Directory to search under. Defaults to the current working directory.',
          },
          file_glob: {
            type: 'string',
            description: 'Optional glob to restrict which files are searched, e.g. "*.js".',
          },
        },
        required: ['pattern'],
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const pattern = args.pattern as string;
    const directory = (args.directory as string) || '.';
    const maxMatches = 200;

    try {
      let files = await walkFiles(directory);

      if (args.file_glob) {
        const re = globToRegExp(args.file_glob as string);
        files = files.filter((f) => re.test(path.basename(f)));
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }

      const matches: Array<{ file: string; line: number; text: string }> = [];

      for (const file of files) {
        if (matches.length >= maxMatches) break;
        const full = path.join(directory, file);
        let content: string;
        try {
          content = await fs.readFile(full, 'utf-8');
        } catch {
          continue; // skip binary/unreadable files
        }

        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (matches.length >= maxMatches) return;
          if (regex.test(line)) {
            matches.push({ file, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }

      return JSON.stringify(matches, null, 2);
    } catch (err) {
      return formatToolError('Error searching files', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `searching for ${chalk.yellow(args.pattern as string)} in ${chalk.yellow((args.directory as string) || '.')}`;
  },
};

export = tool;
