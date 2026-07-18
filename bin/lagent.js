#!/usr/bin/env node

const { ollama, chalk, selectFromList } = require('../src/init.js');
const { chatHandoff } = require('../src/chat.js');
const readline = require("readline");
const path = require("path");

const result = require("dotenv").config({path: path.join(__dirname, "..", ".env"),quiet: true});

async function getModelSelection() {
console.log(__dirname)
  const { models } = await ollama.list();
console.log(result);
  return selectFromList({
    name: 'model',
    message: 'Select a model',
    choices: models.map(model => {
      const sizeGB = (model.size / (1024 ** 3)).toFixed(2);
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

async function supportsThinking(modelName) {
  try {
    const info = await ollama.show({ model: modelName });
    const caps = info.capabilities || [];
    return caps.includes('thinking');
  } catch (err) {
    console.error(chalk.red(`Failed to fetch model info: ${err.message}`));
    return false;
  }
}

async function getEffortSelection() {
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

async function getProvider() {
  return selectFromList({
    name: 'provider',
    message: 'Select a provider',
    choices: [
      { name: 'ollama', message: 'ollama', hint: 'Will let you select from list' },
      { name: 'openrouter', message: 'openrouter', hint: 'Type your own' },
    ],
  });
}

async function openroutersuggested() {
    return selectFromList({
      name: 'suggested',
      message: 'Select what model you\'d like to use from our recommended list, or enter your own',
      choices: [
        { name: 'custom', message: 'Enter my own', hint: 'You must enter a model id like "google/gemma-4-31b-it:free"' },
        { name: 'tencent/hy3:free', message: 'Hy3', hint: '44tps 262K, 21B/295B MoE leaves July 21st' },
        { name: 'google/gemma-4-31b-it:free', message: 'Gemma 4 31b', hint: '20tps 262K, 30.7b' },
        { name: 'nvidia/nemotron-3-ultra-550b-a55b:free', message: 'Nemotron 3 ultra 550b a55b', hint: '42tps 1M, 55B/550B MoE' },
        { name: 'nvidia/nemotron-3-super-120b-a12b:free', message: 'Nemotron 3 Super 120b a12b', hint: '93tps 1M, 12B/120B MoE' },
        { name: 'poolside/laguna-m.1:free', message: 'Laguna M.1', hint: '54tps 262K cont 32k out, ?B leaves July 28th' },
      ],
    });
}

async function openrouterthinking() {
    return selectFromList({
      name: 'effort',
      message: 'Select thinking effort',
      choices: [
        { name: 'false', message: 'False', hint: 'faster, but no reasoning' },
        { name: 'true', message: 'True', hint: 'slower, but yes reasoning' },
      ],
    });
}

async function main() {
  const provider = await getProvider();
  var think = false;
  var selected_model = null;
  if (provider === 'ollama') {
    selected_model = await getModelSelection();
    console.log("generating with " + selected_model);

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
    if (selected_model == "custom") {
      think = await openrouterthinking();
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.input.resume();

      selected_model = await new Promise((resolve) => {
        rl.question("Type selected model: ", (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    }
  }
  await chatHandoff(selected_model, think, provider);
}

main().catch(console.error);