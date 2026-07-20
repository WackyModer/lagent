import chalk from 'chalk';
import { formatToolError } from './utils';
import type { ToolModule } from '../types/common';

const tool: ToolModule = {
  schema: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the contents of a URL (web page or API endpoint) and return the response body as text.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
        },
        required: ['url'],
      },
    },
  },

  async handler(args: Record<string, unknown>, signal?: AbortSignal) {
    const url = args.url as string;
    try {
      const res = await fetch(url, { redirect: 'follow', signal });
      const text = await res.text();
      const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n...[truncated]' : text;
      return JSON.stringify({ status: res.status, body: truncated });
    } catch (err) {
      // If the user cancelled via Ctrl+C, surface that distinctly rather
      // than wrapping it as a generic fetch error.
      if (signal && signal.aborted) {
        const cancel = new Error('Fetch cancelled by user (Ctrl+C).') as Error & { aborted?: boolean };
        cancel.aborted = true;
        throw cancel;
      }
      return formatToolError('Error fetching URL', err);
    }
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `fetching ${chalk.yellow(args.url as string)}`;
  },
};

export = tool;
