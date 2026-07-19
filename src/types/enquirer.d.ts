// Local type declarations augmenting the `enquirer` package.
//
// The bundled enquirer type definitions only export the base `Enquirer`
// class and a generic `Enquirer.Prompt` (BasePrompt). They do not surface
// the `Select` prompt class or the custom methods our prompts override
// (footer/renderChoice/render), so we declare them here to get strong,
// useful typing without fighting the upstream types.

import 'enquirer';

declare module 'enquirer' {
  /** A single selectable choice. */
  export interface SelectChoice {
    name: string;
    message?: string;
    hint?: string;
  }

  /** Options accepted by the `Select` prompt. */
  export interface SelectOptions {
    name: string;
    message: string;
    choices: SelectChoice[];
    footer?: (this: Select) => string;
    renderChoice?: (this: Select, choice: SelectChoice, index: number) => string;
    render?: (this: Select) => Promise<void> | void;
  }

  /** The `Select` prompt class (a subclass of enquirer's BasePrompt). */
  export class Select {
    constructor(options: SelectOptions);
    /** Index of the currently focused choice. */
    index: number;
    /** All choices passed to the prompt. */
    choices: SelectChoice[];
    /** Choices currently within the visible window. */
    visible: SelectChoice[];
    /** Prompt state (e.g. submitted). */
    state: { submitted?: boolean };
    /** Clears the currently written prompt output. */
    clear(): void;
    /** Writes a string to the prompt output stream. */
    write(str: string): void;
    /** Renders a single choice (overridden via options). */
    renderChoice?(this: Select, choice: SelectChoice, index: number): string;
    /** Renders the footer (overridden via options). */
    footer?(this: Select): string;
    /** Runs the prompt, resolving with the selected choice's `name`. */
    run(): Promise<string>;
  }
}
