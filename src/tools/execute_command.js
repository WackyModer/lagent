const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

module.exports = {
  schema: {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a shell command and return its stdout/stderr output.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
        },
        required: ['command'],
      },
    },
  },

  async handler(args) {
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 5,
      });
      return JSON.stringify({ stdout, stderr });
    } catch (err) {
      // exec rejects on non-zero exit code; still return what we got.
      return JSON.stringify({
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        exitCode: err.code,
        signal: err.signal || null,
        killed: err.killed || false,
      });
    }
  },

  describe(args, chalk) {
    return `running ${chalk.yellow(args.command)}`;
  },
};