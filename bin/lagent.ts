#!/usr/bin/env node

import readline from 'readline';
import path from 'path';
import { ollama, chalk, selectFromList } from '../src/init';
import { chatHandoff } from '../src/chat';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

async function getModelSelection(): Promise<string> {
  const { models } = await ollama.list();
  return selectFromList({
    name: 'model',
    message: 'Select a model',
    choices: models.map((model: any) => {
      const sizeGB = (model.size / 1024 ** 3).toFixed(2);
      const modified = new Date(model.modified_at).toLocaleDateString();
      const family = model.details.family || 'unknown';
      const paramSize = model.details.parameter_size || '?';
      const quant = model.details.quantization_level || '?';
      const format = model.details.format || '?';

      return {
        name: model.name,
        message: model.name,
        hint: `${paramSize} • ${quant} • ${format} • ${family} • ${sizeGB}GB • modified ${modified}`,
      };
    }),
  });
}

async function supportsThinking(modelName: string): Promise<boolean> {
  try {
    const info = await ollama.show({ model: modelName });
    const caps = info.capabilities || [];
    return caps.includes('thinking');
  } catch (err) {
    console.error(chalk.red(`Failed to fetch model info: ${(err as Error).message}`));
    return false;
  }
}

async function getEffortSelection(): Promise<string> {
  return selectFromList({
    name: 'effort',
    message: 'Select thinking effort',
    choices: [
      { name: 'low', message: 'low', hint: 'faster, less reasoning' },
      { name: 'medium', message: 'medium', hint: 'balanced' },
      { name: 'high', message: 'high', hint: 'slower, more reasoning' },
    ],
  });
}

async function getProvider(): Promise<string> {
  return selectFromList({
    name: 'provider',
    message: 'Select a provider',
    choices: [
      { name: 'ollama', message: 'ollama', hint: 'Will let you select from list' },
      { name: 'openrouter', message: 'openrouter', hint: 'Type your own' },
    ],
  });
}

async function openroutersuggested(): Promise<string> {
  return selectFromList({
    name: 'suggested',
    message: 'Select what model you\'d like to use from our recommended list, or enter your own',
    choices: [
      { name: 'custom', message: 'Enter my own', hint: 'You must enter a model id like "google/gemma-4-31b-it:free"' },
      { name: 'google/gemma-4-31b-it:free', message: 'Gemma 4 31b', hint: '20tps 262K, 30.7b' },
      { name: 'nvidia/nemotron-3-ultra-550b-a55b:free', message: 'Nemotron 3 ultra 550b a55b', hint: '42tps 1M, 55B/550B MoE' },
      { name: 'nvidia/nemotron-3-super-120b-a12b:free', message: 'Nemotron 3 Super 120b a12b', hint: '93tps 1M, 12B/120B MoE' },
      { name: 'poolside/laguna-s-2.1:free', message: 'Laguna S 2.1', hint: '71tps 262K, 8B/118 MoE' },
      { name: 'poolside/laguna-m.1:free', message: 'Laguna M.1', hint: '54tps 262K cont 32k out, ?B leaves July 28th' },
    ],
  });
}

async function openrouterthinking(): Promise<string> {
  return selectFromList({
    name: 'effort',
    message: 'Select thinking effort',
    choices: [
      { name: 'false', message: 'False', hint: 'faster, but no reasoning' },
      { name: 'true', message: 'True', hint: 'slower, but yes reasoning' },
    ],
  });
}

async function main(): Promise<void> {
  const provider = await getProvider();
  let think: string | boolean = false;
  let selected_model: string | null = null;
  if (provider === 'ollama') {
    selected_model = await getModelSelection();
    console.log('generating with ' + selected_model);

    const canThink = await supportsThinking(selected_model);

    if (canThink) {
      think = await getEffortSelection();
      console.log(chalk.gray(`thinking effort: ${think}`));
    } else {
      console.log(chalk.gray('model does not support thinking, skipping'));
    }
  } else if (provider === 'openrouter') {
    selected_model = await openroutersuggested();
    think = true;
    if (selected_model === 'custom') {
      think = await openrouterthinking();
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      process.stdin.resume();

      selected_model = await new Promise<string>((resolve) => {
        rl.question('Type selected model: ', (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    }
  }
  await chatHandoff(selected_model as string, think, provider as 'ollama' | 'openrouter');
}

main().catch(console.error);
