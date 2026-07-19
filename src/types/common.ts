import type chalk from 'chalk';

/** A function-tool schema in the OpenAI/Ollama style. */
export interface ToolFunctionSchema {
  name: string;
  description?: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ToolSchema {
  type: 'function';
  function: ToolFunctionSchema;
}

/** A tool-call request emitted by the model. */
export interface ToolCallFunction {
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: ToolCallFunction;
}

/** A single message in the conversation history. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** A streamed chunk returned by the provider adapters. */
export interface StreamChunk {
  message: {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
    thinking?: string;
  };
  done: boolean;
}

/** Shape a tool module must export. */
export interface ToolModule {
  schema: ToolSchema;
  handler: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  describe: (args: Record<string, unknown>, c: typeof chalk) => string;
}

export interface LoadedTools {
  schemas: ToolSchema[];
  handlers: Record<string, ToolModule['handler']>;
  describers: Record<string, ToolModule['describe']>;
  names: string[];
}
