const { formatToolError } = require('./utils');

module.exports = {
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

  async handler(args) {
    try {
      const res = await fetch(args.url, { redirect: 'follow' });
      const text = await res.text();
      const truncated = text.length > 20_000 ? text.slice(0, 20_000) + '\n...[truncated]' : text;
      return JSON.stringify({ status: res.status, body: truncated });
    } catch (err) {
      return formatToolError('Error fetching URL', err);
    }
  },

  describe(args, chalk) {
    return `fetching ${chalk.yellow(args.url)}`;
  },
};