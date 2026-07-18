const fs = require('fs/promises');
const path = require('path');

/**
 * Formats an error for inclusion in a tool result sent back to the model.
 * Includes name/code/message so the model has enough to self-correct.
 */
function formatToolError(prefix, err) {
  const parts = [`${prefix}: ${err.message}`];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.syscall) parts.push(`syscall=${err.syscall}`);
  return parts.join(' | ');
}

const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '.next']);

/**
 * Recursively walks a directory, yielding file paths (relative to root),
 * skipping common noisy directories.
 */
async function walkFiles(root, dir = root, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
      await walkFiles(root, path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }

  return out;
}

/**
 * Minimal glob-to-regex converter supporting *, **, and ?.
 */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

module.exports = {
  formatToolError,
  walkFiles,
  globToRegExp,
  DEFAULT_IGNORE_DIRS,
};