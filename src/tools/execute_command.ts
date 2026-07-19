import { spawn, exec } from 'child_process';
import chalk from 'chalk';
import type { ToolModule } from '../types/common';

/**
 * Kills an entire process tree rooted at `child`, across platforms.
 *
 * Just calling child.kill() only terminates the immediate shell wrapper,
 * leaving the command it spawned (and that command's children) running.
 * To actually cancel the model's task we need to tear down the whole tree:
 *   - POSIX: the child is launched detached so it owns its own process
 *     group; we SIGKILL the negative pid to hit the whole group.
 *   - Windows: negative-pid kill isn't supported, so we shell out to
 *     `taskkill /PID <pid> /T /F` which recursively force-kills the tree.
 *
 * Best-effort: any failure to kill is swallowed so cancellation of the
 * await still proceeds.
 */
function killProcessTree(
  child: { pid?: number | null; kill: (signal?: NodeJS.Signals | number) => boolean } | null
): void {
  if (!child || child.pid == null) return;
  const pid = child.pid;

  try {
    if (process.platform === 'win32') {
      try {
        // /T = terminate child processes too, /F = force.
        exec(`taskkill /PID ${pid} /T /F`, () => {});
      } catch {
        /* ignore */
      }
    } else {
      // Kill the whole process group (negative pid) on POSIX.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Process may already be gone, or group kill failed — try the direct
    // kill as a last resort.
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

const tool: ToolModule = {
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

  /**
   * Runs a shell command. If `signal` is provided and aborts (e.g. the user
   * pressed Ctrl+C while this task was running), the entire spawned process
   * tree is force-killed so the model's task is truly cancelled rather than
   * left running in the background.
   *
   * @param args - { command }
   * @param signal - Cancels the command when aborted.
   */
  async handler(args: Record<string, unknown>, signal?: AbortSignal) {
    const command = args.command as string;
    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      // On POSIX, detach so the child gets its own process group (pid ===
      // pgid), letting us SIGKILL the whole group on cancellation.
      detached: !isWin,
    });

    let stdout = '';
    let stderr = '';
    let killedByUs = false;

    child.stdout.on('data', (d: Buffer | string) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer | string) => { stderr += d.toString(); });

    // If the caller aborts (Ctrl+C), tear down the whole process tree.
    if (signal) {
      const onAbort = () => {
        killedByUs = true;
        killProcessTree(child);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (code: number | null) => resolve(code));
    });

    if (signal && signal.aborted) {
      // Treat cancellation as an explicit, surfaced outcome rather than
      // letting it bubble as a generic rejection.
      const err = new Error('Command cancelled by user (Ctrl+C).') as Error & { killed?: boolean; aborted?: boolean };
      err.killed = true;
      err.aborted = true;
      throw err;
    }

    if (killedByUs) {
      const err = new Error('Command killed by user (Ctrl+C).') as Error & { killed?: boolean; aborted?: boolean };
      err.killed = true;
      err.aborted = true;
      throw err;
    }

    return JSON.stringify({
      stdout,
      stderr,
      exitCode,
    });
  },

  describe(args: Record<string, unknown>, c: typeof chalk) {
    return `running ${chalk.yellow(args.command as string)}`;
  },
};

export = tool;
