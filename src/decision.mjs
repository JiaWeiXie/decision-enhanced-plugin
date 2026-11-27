import { randomUUID } from 'node:crypto';
import { TypeSafeClient, noul, choice, score } from './vendor/typesafe-sdk.mjs';
import { decisionRequest, decisionResponse, keyNames, providerConfig, providerNames } from './decision-providers.mjs';
import { checkKeyedAnswer, isRecord, normalizeUsage } from './decision-response.mjs';
import { resolveCustomHeaders } from './decision-custom.mjs';
import { directFetch, pinnedFetch } from './decision-transport.mjs';

export { noul, choice, score };

const autoOrder = ['typesafe', 'openai', 'gemini'];
const providerKeyNames = Object.values(keyNames).flat();
// Protect unrelated Google credentials if pasted into a pack. Never use them for inference.
const protectedKeyNames = [...providerKeyNames, 'GOOGLE_API_KEY'];
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
  constructor(reason = 'judgments_unavailable', status = 0, decision = null) {
    super(reason);
    this.reason = reason;
    this.status = Number.isInteger(status) ? status : 0;
    this.decision = decision;
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
// Reconstruct output fields from validated values. Provider text and extra fields never reach callers.
function validateAnswers(answers, questions, protocol, wire = false) {
  // The Gemini guide shows two-decimal probabilities that can add up to 1.01.
  const sumTolerance = protocol === 'gemini' ? 0.01 + 4 * Number.EPSILON : 0.001;
  if (!isRecord(answers) || Object.keys(answers).length !== Object.keys(questions).length) throw new DecisionError();
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = Object.hasOwn(answers, id) ? answers[id] : null;
    if (!isRecord(answer) || answer.type !== question.type) throw new DecisionError();
    if (question.type === 'noul') {
      if (!checkKeyedAnswer(answer, question.type, [], probability, wire ? protocol : undefined)) throw new DecisionError();
      return [id, { type: 'noul', noul: answer.noul }];
    }
    const keys = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
    const distribution = answer.probabilities;
    if (!checkKeyedAnswer(answer, question.type, keys, probability, wire ? protocol : undefined) ||
      !isRecord(distribution) || Object.keys(distribution).length !== keys.length ||
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
  const keys = [...explicitKeys, ...protectedKeyNames.map(variable => env[variable]?.trim())].filter(Boolean);
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
  model, apiKey, custom, fetchImpl, mockAnswers, onAttempt, timeoutMs = 30_000 } = {}) {
  if (!['live', 'dry-run', 'mock'].includes(mode)) throw new TypeError('Unknown client mode');
  const selection = validateProvider(requested ?? env.DECISION_PROVIDER);
  const live = mode === 'live';
  const configuredKey = name => {
    if ((name === 'typesafe' || (name === 'openai' && selection === 'openai')) && apiKey != null) {
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
  return {
    async ask(state, questions, { signal } = {}) {
      if (mode === 'mock') {
        return { mode, provider: null, answers: validateAnswers(mockAnswers, questions, selection), model: null };
      }
      const request = JSON.parse(JSON.stringify({ state, model: config.model, questions }));
      // Inspect question criteria as well as the state, including text stored only in choices.
      let customAuth;
      if (provider === 'custom') {
        try {
          customAuth = resolveCustomHeaders(config.bindings, env, live);
        } catch {
          throw new DecisionError('invalid_provider_config');
        }
      }
      const customKeys = customAuth?.values ?? [];
      if (customKeys.some(value => protectedKeyNames.some(name => env[name]?.trim() === value))) {
        throw new DecisionError('invalid_provider_config');
      }
      rejectSecrets(request, env, [key, ...customKeys]);
      if (provider === 'custom') {
        const path = new URL(config.endpoint).pathname;
        let decodedPath = path;
        try { decodedPath = decodeURIComponent(path); } catch { /* Keep the wire path. */ }
        rejectSecrets([config.endpoint, decodedPath, customAuth.genericValues], env, customKeys);
      }
      if (mode === 'dry-run') {
        const preview = { mode, provider, request, answers: null };
        rejectSecrets(JSON.stringify(preview, null, 2), env, customKeys);
        return preview;
      }
      const decision = Object.freeze({
        id: randomUUID(), provider, model: config.model, origin: new URL(config.endpoint).origin,
        credential: customAuth?.credentialNames ??
          (keyNames[provider] ? keyNames[provider].find(name => env[name]?.trim() === key) ?? 'explicit' : null),
      });
      rejectSecrets(decision, env, [key, ...customKeys]);
      let payloadBlocked = false;
      const send = fetchImpl ?? directFetch;
      const transport = pinnedFetch({
        endpoint: config.endpoint, headers: customAuth?.headers ?? config.headers,
      }, (url, options) => {
        onAttempt?.(decision);
        return send(url, options);
      }, body => {
        try {
          rejectSecrets([body, JSON.parse(body)], env, [key, ...customKeys]);
        } catch (error) {
          payloadBlocked = error instanceof DecisionError;
          throw error;
        }
      });
      try {
        let response;
        if (provider === 'typesafe') {
          const client = new TypeSafeClient({
            apiKey: key, baseURL: 'https://api.typesafe.ai', defaultModel: config.model,
            fetch: transport, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: 'off',
          });
          response = decisionResponse('typesafe', await client.systemOne(request, { signal }), request.questions);
        } else {
          const body = decisionRequest(config.protocol, request, config.limits);
          const timeout = AbortSignal.timeout(timeoutMs);
          const result = await transport(config.endpoint, {
            method: 'POST', body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          if (!result.ok) throw new DecisionError('judgments_unavailable', result.status);
          response = decisionResponse(config.protocol, await result.json(), request.questions);
        }
        return {
          mode, provider,
          model: provider === 'typesafe' ? safeTypeSafeModel(response?.model, config.model, env, key) : config.model,
          usage: normalizeUsage(response?.usage, config.protocol),
          answers: validateAnswers(response?.answers, request.questions, config.protocol, true),
          decision,
        };
      } catch (error) {
        // Neither provider body, payload, credential, nor exception message is diagnostic output.
        if (payloadBlocked) throw new DecisionError('unsafe_payload');
        throw new DecisionError('judgments_unavailable', error?.status, decision);
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
