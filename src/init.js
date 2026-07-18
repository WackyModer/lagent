const { Ollama } = require('ollama');
const chalk = require('chalk');
const { Select } = require('enquirer');
const path = require("path");

const result = require("dotenv").config({path: path.join(__dirname, "..", ".env"),quiet: true});

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  // headers: { Authorization: 'Bearer ' + process.env.OLLAMA_API_KEY },
});

/**
 * Reusable list selection prompt.
 *
 * @param {Object} opts
 * @param {string} opts.name - Prompt name.
 * @param {string} opts.message - Prompt message shown above the list.
 * @param {Array<{name: string, message: string, hint?: string}>} opts.choices
 * @returns {Promise<string>} The selected choice's `name`.
 */
async function selectFromList({ name, message, choices }) {
  const prompt = new Select({
    name,
    message,
    choices,

    footer() {
      return chalk.gray('↑↓ Move • Enter Select • Ctrl+C Exit');
    },

    renderChoice(choice, i) {
      const focused = this.index === i;
      const prefix = focused
        ? chalk.cyan('❯')
        : ' ';

      const name = focused
        ? chalk.bold.white(choice.message)
        : chalk.gray(choice.message);

      const hint = choice.hint
        ? chalk.dim(` (${choice.hint})`)
        : '';

      return `${prefix} ${name}${hint}`;
    },

    async render() {
      this.clear();

      if (this.state.submitted) {
        const selected = this.choices[this.index];
        this.write(`${chalk.green('>')} ${message} ${chalk.cyan(selected.message)}\n`);
        return;
      }

      let output = '';

      this.visible.forEach((choice, i) => {
        output += this.renderChoice(choice, i) + '\n';
      });

      output += '\n' + await this.footer();

      this.write(output);
    }
  });

  const answer = await prompt.run();
  return answer;
}

module.exports = {
  ollama,
  chalk,
  selectFromList,
};