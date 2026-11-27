import { TypeSafeClient, noul, choice, score } from './vendor/typesafe-sdk.mjs';
import { decisionRequest, decisionResponse, keyNames, pinnedFetch, providerConfig, providerNames } from './decision-providers.mjs';
import { directFetch } from './decision-custom.mjs';

export { noul, choice, score };

const autoOrder = ['typesafe', 'openai', 'gemini'];
const providerKeyNames = Object.values(keyNames).flat();
const secretProperty = /^(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|passwd|authorization)$/i;
const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  /\b(?:sk-(?:proj-|svcacct-|ant-api\d+-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|AIza[a-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/i,
  /\beyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{12,}\b/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{12,}/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|password|passwd)["']?\s*[:=]\s*["']?[^\s"'<>.,`]{12,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i,
];

export class DecisionError extends Error {
  constructor(reason = 'judgments_unavailable', status = 0) {
    super(reason);
    this.reason = reason;
    this.status = Number.isInteger(status) ? status : 0;
  }
}

export class MissingApiKeyError extends DecisionError {
  constructor() {
    super('missing_api_key');
  }
}

export function validateProvider(value) {
  const provider = value ?? 'typesafe';
  if (provider !== 'auto' && !providerNames.includes(provider)) throw new DecisionError('unknown_provider');
  return provider;
}

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownUsage = ['input_tokens', 'output_tokens', 'total_input_tokens', 'total_output_tokens',
  'total_tokens', 'total_cached_tokens', 'prompt_tokens', 'completion_tokens'];

function safeUsage(usage) {
  if (!record(usage)) return null;
  const entries = knownUsage.filter(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0);
  return Object.fromEntries(entries.map(name => [name, usage[name]]));
}

// Reconstruct output fields from validated values. Provider text and extra fields never reach callers.
function validateAnswers(answers, questions, protocol) {
  // The Gemini guide shows two-decimal probabilities that can add up to 1.01.
  const sumTolerance = protocol === 'gemini' ? 0.01 + 4 * Number.EPSILON : 0.001;
  if (!record(answers) || Object.keys(answers).length !== Object.keys(questions).length) throw new DecisionError();
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = Object.hasOwn(answers, id) ? answers[id] : null;
    if (!record(answer) || answer.type !== question.type) throw new DecisionError();
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new DecisionError();
      return [id, { type: 'noul', noul: answer.noul }];
    }
    const keys = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
    const distribution = answer.probabilities;
    if (!record(distribution) || Object.keys(distribution).length !== keys.length ||
      keys.some(key => !Object.hasOwn(distribution, key) || !probability(distribution[key])) ||
      Math.abs(keys.reduce((sum, key) => sum + distribution[key], 0) - 1) > sumTolerance ||
      !probability(answer.confidence)) throw new DecisionError();
    const normalized = {
      type: question.type, confidence: answer.confidence,
      probabilities: Object.fromEntries(keys.map(key => [key, distribution[key]])),
    };
    if (question.type === 'choice') {
      if (!keys.includes(answer.choice)) throw new DecisionError();
      normalized.choice = answer.choice;
    } else {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1) {
        throw new DecisionError();
      }
      normalized.score = answer.score;
    }
    return [id, normalized];
  }));
}

function hasSecret(text, keys) {
  return secretPatterns.some(pattern => pattern.test(text)) || keys.some(key => text.includes(key));
}

export function rejectSecrets(value, env = process.env, explicitKeys = []) {
  const keys = [...explicitKeys, ...providerKeyNames.map(variable => env[variable]?.trim())].filter(Boolean);
  scanSecrets(value, keys);
}

function scanSecrets(value, keys) {
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && hasSecret(item, keys)) throw new DecisionError('unsafe_payload');
    if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      for (const [name, content] of Object.entries(item)) {
        if (secretProperty.test(name) && typeof content === 'string' && content.trim().length >= 12) {
          throw new DecisionError('unsafe_payload');
        }
        pending.push(name, content);
      }
    }
  }
}

function safeTypeSafeModel(value, fallback, env, key) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) return fallback;
  try {
    rejectSecrets(value, env, [key]);
    return value;
  } catch {
    return fallback;
  }
}

function keyFor(provider, env) {
  return keyNames[provider]?.map(name => env[name]?.trim()).find(Boolean);
}

export function createClient({ mode = 'live', provider: requested, env = process.env,
  model, apiKey, custom, fetchImpl, mockAnswers, timeoutMs = 30_000 } = {}) {
  if (!['live', 'dry-run', 'mock'].includes(mode)) throw new TypeError('Unknown client mode');
  const selection = validateProvider(requested ?? env.DECISION_PROVIDER);
  const live = mode === 'live';
  const configuredKey = name => {
    if (name !== 'cloudflare' && (selection !== 'auto' || name === 'typesafe') && apiKey != null) {
      return apiKey.trim();
    }
    return keyFor(name, env);
  };
  const provider = selection === 'auto'
    ? (live ? autoOrder.find(configuredKey) : undefined) ?? 'typesafe'
    : selection;
  const key = live && keyNames[provider] ? configuredKey(provider) : undefined;
  if (live && keyNames[provider] && !key) throw new MissingApiKeyError();
  if (key && /[^\x21-\x7e]/.test(key)) throw new DecisionError('invalid_provider_config');
  let config;
  try {
    config = mode === 'mock' ? null : providerConfig(provider, { env, model, apiKey: key, custom, live });
  } catch {
    throw new DecisionError('invalid_provider_config');
  }
  const transport = pinnedFetch(config?.endpoint, fetchImpl ??
    (provider === 'custom' || provider === 'ollama' ? directFetch : globalThis.fetch));
  return {
    async ask(state, questions) {
      if (mode === 'mock') {
        return { mode, provider: null, answers: validateAnswers(mockAnswers, questions, selection), model: null };
      }
      const request = JSON.parse(JSON.stringify({ state, model: config.model, questions }));
      // Inspect question criteria as well as the state, including text stored only in choices.
      const customKeys = provider === 'custom' ? Object.values(config.headers)
        .flatMap(value => [value, value.replace(/^(?:bearer|basic) +/i, '')]) : [];
      rejectSecrets(request, env, [key, ...customKeys]);
      if (provider === 'custom') {
        const path = new URL(config.endpoint).pathname;
        let decodedPath = path;
        try { decodedPath = decodeURIComponent(path); } catch { /* Keep the wire path. */ }
        rejectSecrets([config.endpoint, decodedPath], env, customKeys);
      }
      if (mode === 'dry-run') return { mode, provider, request, answers: null };
      try {
        let response;
        if (provider === 'typesafe') {
          const client = new TypeSafeClient({
            apiKey: key, baseURL: 'https://api.typesafe.ai', defaultModel: config.model,
            fetch: transport, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: 'off',
          });
          response = await client.systemOne(request);
        } else {
          const body = decisionRequest(config.protocol, request, config.limits);
          const result = await transport(config.endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...config.headers },
            body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
          });
          if (!result.ok) throw new DecisionError('judgments_unavailable', result.status);
          response = decisionResponse(config.protocol, await result.json(), request.questions);
        }
        return {
          mode, provider,
          model: provider === 'typesafe' ? safeTypeSafeModel(response?.model, config.model, env, key) : config.model,
          usage: safeUsage(response?.usage),
          answers: validateAnswers(response?.answers, request.questions, config.protocol),
        };
      } catch (error) {
        // Neither provider body, payload, credential, nor exception message is diagnostic output.
        throw new DecisionError('judgments_unavailable', error?.status);
      }
    },
  };
}

export async function loadMockAnswers(path) {
  const { readFile } = await import('node:fs/promises');
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value?.answers ?? value;
  } catch {
    throw new Error('Mock fixture must be readable JSON');
  }
}
