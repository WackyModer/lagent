import { Ollama } from 'ollama';
import chalk from 'chalk';
import { Select } from 'enquirer';
import path from 'path';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://localhost:11434',
  // headers: { Authorization: 'Bearer ' + process.env.OLLAMA_API_KEY },
});

/** A single selectable choice. */
export interface SelectChoice {
  name: string;
  message?: string;
  hint?: string;
}

/** Options accepted by selectFromList. */
export interface SelectOptions {
  name: string;
  message: string;
  choices: SelectChoice[];
}

/**
 * Reusable list selection prompt.
 *
 * @param opts
 * @param opts.name - Prompt name.
 * @param opts.message - Prompt message shown above the list.
 * @param opts.choices
 * @returns The selected choice's `name`.
 */
async function selectFromList({ name, message, choices }: SelectOptions): Promise<string> {
  const prompt = new Select({
    name,
    message,
    choices,

    footer(this: Select) {
      return chalk.gray('↑↓ Move • Enter Select • Ctrl+C Exit');
    },

    renderChoice(this: Select, choice: SelectChoice, i: number) {
      const focused = this.index === i;
      const prefix = focused ? chalk.cyan('❯') : ' ';

      const nameStr = focused
        ? chalk.bold.white(choice.message)
        : chalk.gray(choice.message);

      const hint = choice.hint ? chalk.dim(` (${choice.hint})`) : '';

      return `${prefix} ${nameStr}${hint}`;
    },

    async render(this: Select) {
      this.clear();

      if (this.state.submitted) {
        const selected = this.choices[this.index];
        this.write(`${chalk.green('>')} ${message} ${chalk.cyan(selected.message)}\n`);
        return;
      }

      let output = '';

      this.visible.forEach((choice: SelectChoice, i: number) => {
        output += (this.renderChoice ? this.renderChoice(choice, i) : choice.message ?? '') + '\n';
      });

      output += '\n' + (this.footer ? await this.footer() : '');

      this.write(output);
    },
  });

  const answer = await prompt.run();
  return answer;
}

export { ollama, chalk, selectFromList };
