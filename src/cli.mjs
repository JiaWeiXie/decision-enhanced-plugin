#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createClient, loadMockAnswers, MissingApiKeyError, TypeSafeError } from './jev.mjs';
import { PROVIDER_NAMES, ProviderError } from './providers.mjs';
import { packs, getPack } from '../packs/registry.mjs';

const usage = `Usage: node src/cli.mjs <pack> --state <file|-> [--dry-run | --mock <file>] [--json]
       [--provider <name>] [--model <id>] [--base-url <url> --api-format <format>]
Live mode is the default. TypeSafe is used unless another provider is explicitly selected.
Providers: ${PROVIDER_NAMES.join(', ')}
Self-hosted API formats: system-one, openai-chat, ollama-chat.
Supply only minimal evidence free of secrets, customer data, and sensitive personal data.
--dry-run performs no inference. --mock replays synthetic or recorded values, not live judgments.
Packs: ${Object.keys(packs).join(', ')}\n`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: {
      state: { type: 'string' }, 'dry-run': { type: 'boolean' }, mock: { type: 'string' },
      provider: { type: 'string' }, model: { type: 'string' },
      'base-url': { type: 'string' }, 'api-format': { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean' }, list: { type: 'boolean' },
    }
  });
  if (values.help || values.list) { process.stdout.write(usage); return; }
  if (positionals.length !== 1 || !values.state || !getPack(positionals[0])) throw new Error(usage);
  const replay = values.mock !== undefined;
  if (replay && !values.mock.trim()) throw new Error('--mock requires a nonempty file path');
  if (values['dry-run'] && replay) throw new Error('Choose either --dry-run or --mock');
  if (values.model !== undefined && !values.model.trim()) throw new Error('--model requires a model ID');
  const pack = getPack(positionals[0]);
  let text;
  if (values.state === '-') {
    process.stdin.setEncoding('utf8');
    text = '';
    for await (const chunk of process.stdin) text += chunk;
  } else text = await readFile(values.state, 'utf8');
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Error('State must be valid JSON');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('State must be a JSON object');
  const problem = pack.validateState(state);
  if (problem) throw new Error(problem);
  const questions = pack.buildQuestions(state, {});
  // The model sees only what the questions reference; code-only fields stay local.
  const modelState = pack.buildState(state);
  const mode = values['dry-run'] ? 'dry-run' : replay ? 'mock' : 'live';
  const options = { provider: values.provider, model: values.model,
    baseUrl: values['base-url'], format: values['api-format'] };
  const hasProviderOptions = Object.values(options).some(value => value !== undefined);
  if (replay && hasProviderOptions) throw new Error('Provider options cannot be used with --mock');
  let response;
  let reason = null;
  try {
    if (mode !== 'dry-run' && Object.keys(questions).length === 0) {
      if (hasProviderOptions) createClient({ ...options, mode: 'dry-run' });
      response = { mode: 'not-needed', answers: {} };
    } else {
      const client = createClient({ ...options, mode, mockAnswers: replay ? await loadMockAnswers(values.mock) : null });
      response = await client.ask(modelState, questions);
    }
  } catch (error) {
    if (!(error instanceof MissingApiKeyError || error instanceof TypeSafeError ||
      error instanceof ProviderError)) throw error;
    reason = error.reason ?? 'judgments_unavailable';
    response = { mode: 'unavailable', answers: null, degraded: reason };
    const alternateProvider = options.provider && options.provider !== 'typesafe';
    if (alternateProvider) response.provider = options.provider;
    const detail = error instanceof MissingApiKeyError && alternateProvider ? ` (${error.message})` : '';
    const label = alternateProvider ? 'provider' : 'Jev';
    process.stderr.write(`${reason}${detail}: continue the skill using evidence, without ${label} judgments.\n`);
    process.exitCode = 3;
  }
  if (mode === 'dry-run') {
    process.stdout.write(JSON.stringify(response, null, 2) + '\n');
    return;
  }
  const result = pack.decide(response, state, {});
  const output = {
    mode: response.mode, model: response.model ?? null,
    usage: response.usage ?? null, reason, answers: response.answers, result,
    ...(response.provider && { provider: response.provider }),
    ...(response.format && { format: response.format }),
    ...(response.suggestions && { suggestions: response.suggestions }),
  };
  const source = response.provider ? ` (${response.provider}${response.model ? ` / ${response.model}` : ''})` : '';
  const suggestions = response.suggestions
    ? `\nGenerated suggestions (advisory, without probabilities)\n${JSON.stringify(response.suggestions, null, 2)}\n`
    : '';
  process.stdout.write(values.json ? JSON.stringify(output, null, 2) + '\n'
    : `Mode: ${response.mode}${source}\n${pack.render(result, state)}${suggestions}`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
