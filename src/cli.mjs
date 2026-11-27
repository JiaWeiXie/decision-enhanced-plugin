#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient, loadMockAnswers, DecisionError, rejectSecrets, validateProvider } from './decision.mjs';
import { packs, getPack } from '../packs/registry.mjs';

const usage = `Usage: decision-pack <pack> --state <file|-> [--provider auto|typesafe|openai|gemini|cloudflare|ollama|custom] [--dry-run | --mock <file>] [--json]
Live mode is the default. Provider selection uses --provider, then DECISION_PROVIDER, then auto.
Use --model for Cloudflare, Ollama, or a custom endpoint. Custom also accepts --custom-base or --custom-endpoint and --custom-protocol.
Supply only minimal evidence free of secrets, customer data, and sensitive personal data.
--dry-run performs no inference. --mock replays synthetic or recorded values, not live judgments.
Packs: ${Object.keys(packs).join(', ')}\n`;

class InputError extends Error {}

function writeOutput(output, json, rendered = '') {
  process.stdout.write(json ? JSON.stringify(output, null, 2) + '\n' : `Mode: ${output.mode}\n${rendered}`);
}

function unavailable(reason) {
  process.exitCode = 3;
  process.stderr.write(`${reason}: continue the skill using local evidence.\n`);
  return { mode: 'unavailable', provider: null, model: null, usage: null, reason, answers: null };
}

async function readState(path) {
  let text;
  try {
    if (path === '-') {
      process.stdin.setEncoding('utf8');
      text = '';
      for await (const chunk of process.stdin) text += chunk;
    } else text = await readFile(path, 'utf8');
  } catch {
    throw new InputError('State must be readable');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError('State must be valid JSON');
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true, options: {
        state: { type: 'string' }, 'dry-run': { type: 'boolean' }, mock: { type: 'string' },
        provider: { type: 'string' }, model: { type: 'string' },
        'custom-base': { type: 'string' }, 'custom-endpoint': { type: 'string' }, 'custom-protocol': { type: 'string' },
        json: { type: 'boolean' }, help: { type: 'boolean' }, list: { type: 'boolean' },
      },
    });
  } catch {
    throw new InputError('Invalid arguments. Use --help for usage.');
  }
  const { values, positionals } = parsed;
  if (values.help || values.list) { process.stdout.write(usage); return; }
  const pack = positionals.length === 1 && getPack(positionals[0]);
  if (!values.state || !pack) throw new InputError(usage);
  if (values['dry-run'] && values.mock) throw new InputError('Choose either --dry-run or --mock');
  const json = values.json || values['dry-run'];
  let provider;
  try {
    provider = validateProvider(values.provider ?? process.env.DECISION_PROVIDER);
    if ((provider !== 'custom' && ['custom-base', 'custom-endpoint', 'custom-protocol'].some(name => values[name] !== undefined)) ||
      (values.model !== undefined && !['cloudflare', 'ollama', 'custom'].includes(provider))) {
      throw new DecisionError('invalid_provider_config');
    }
  } catch (error) {
    writeOutput({ ...unavailable(error.reason), result: null }, json);
    return;
  }

  const state = await readState(values.state);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new InputError('State must be a JSON object');
  const problem = pack.validateState(state);
  if (problem) throw new InputError(problem);
  const questions = pack.buildQuestions(state, {});
  const modelState = pack.buildState(state);
  const mode = values['dry-run'] ? 'dry-run' : values.mock ? 'mock' : 'live';
  let response;
  try {
    if (mode !== 'mock') rejectSecrets({ state: modelState, questions });
    const options = {
      mode, provider, model: values.model,
      custom: {
        base: values['custom-base'], endpoint: values['custom-endpoint'], protocol: values['custom-protocol'],
      },
    };
    if (mode !== 'dry-run' && Object.keys(questions).length === 0) {
      if (mode === 'live' && ['cloudflare', 'ollama', 'custom'].includes(provider)) createClient(options);
      response = { mode: 'not-needed', answers: {} };
    } else {
      const mockAnswers = values.mock ? await loadMockAnswers(values.mock).catch(() => {
        throw new InputError('Mock fixture must be readable JSON');
      }) : null;
      const client = createClient({ ...options, mockAnswers });
      response = await client.ask(modelState, questions);
    }
  } catch (error) {
    if (!(error instanceof DecisionError)) throw error;
    response = unavailable(error.reason);
  }

  if (mode === 'dry-run' || response.reason === 'unsafe_payload') {
    writeOutput(response, json);
    return;
  }
  const result = pack.decide(response, state, {});
  const output = {
    mode: response.mode, provider: response.provider ?? null, model: response.model ?? null,
    usage: response.usage ?? null, reason: response.reason ?? null, answers: response.answers, result,
  };
  writeOutput(output, json, json ? '' : pack.render(result, state));
}

main().catch(error => {
  process.stderr.write(`${error instanceof InputError ? error.message : 'Could not run the decision pack'}\n`);
  process.exitCode = 2;
});
