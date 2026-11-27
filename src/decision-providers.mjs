import { customEndpoint, customHeaders } from './decision-custom.mjs';

export const endpoints = Object.freeze({
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openai: 'https://api.openai.com/v1/decisions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/decisions',
  ollama: 'http://localhost:11434/v1/systemone',
});

export const models = Object.freeze({
  openai: 'gpt-6-luna',
  gemini: 'gemini-decision-1',
});

export const keyNames = Object.freeze({
  typesafe: ['TYPESAFE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  cloudflare: ['CLOUDFLARE_AUTH_TOKEN'],
});

const cloudflareModels = ['clef', 'clef-flash', 'clef-omni'];
const ollamaModels = ['clef', 'clef:cloud'];
const protocolPaths = {
  systemone: '/v1/systemone', openai: '/v1/decisions', gemini: '/v1beta/decisions',
};
export const providerNames = ['typesafe', 'openai', 'gemini', 'cloudflare', 'ollama', 'custom'];
const cloudflarePath = model => '/ai/run/@cf/cloudflare/' + model;
const protocolPath = (protocol, model) => protocolPaths[protocol] ?? cloudflarePath(model);
const invalidConfig = () => new Error('Invalid provider configuration');

export function providerConfig(provider, { env, model, apiKey, custom = {}, live }) {
  if (provider === 'cloudflare') {
    model = model ?? env.DECISION_CLOUDFLARE_MODEL ?? 'clef';
    const account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!cloudflareModels.includes(model) || (live && !/^[a-f0-9]{32}$/i.test(account ?? ''))) throw invalidConfig();
    return {
      model, protocol: 'cloudflare',
      endpoint: live ? 'https://api.cloudflare.com/client/v4/accounts/' + account + cloudflarePath(model) : null,
      headers: live ? { Authorization: 'Bearer ' + apiKey } : {},
    };
  }
  if (provider === 'ollama') {
    model = model ?? env.DECISION_OLLAMA_MODEL ?? 'clef';
    if (!ollamaModels.includes(model)) throw invalidConfig();
    return {
      model, protocol: 'systemone', endpoint: endpoints.ollama, headers: {},
      limits: { choices: model === 'clef' ? 26 : 255, questions: 64, levels: 10 },
    };
  }
  if (provider === 'custom') {
    const protocol = custom.protocol ?? env.DECISION_CUSTOM_PROTOCOL;
    const base = custom.base ?? env.DECISION_CUSTOM_BASE_URL;
    const exact = custom.endpoint ?? env.DECISION_CUSTOM_ENDPOINT;
    model = model ?? env.DECISION_CUSTOM_MODEL;
    if (Boolean(base) === Boolean(exact) || (!Object.hasOwn(protocolPaths, protocol) && protocol !== 'cloudflare') ||
      !/^[a-z0-9@][a-z0-9_/@.:-]{0,95}$/i.test(model ?? '')) throw invalidConfig();
    if (base && protocol === 'cloudflare' && !cloudflareModels.includes(model)) throw invalidConfig();
    const endpoint = exact ? customEndpoint(exact) : customEndpoint(base, protocolPath(protocol, model));
    const reserved = [...Object.values(keyNames).flat(), 'CLOUDFLARE_ACCOUNT_ID'];
    let authEndpoint;
    if (env.DECISION_CUSTOM_AUTH_ENDPOINT !== undefined) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_AUTH_ENDPOINT);
    } else if (env.DECISION_CUSTOM_HEADERS !== undefined && env.DECISION_CUSTOM_ENDPOINT) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_ENDPOINT);
    } else if (env.DECISION_CUSTOM_HEADERS !== undefined && env.DECISION_CUSTOM_BASE_URL &&
      env.DECISION_CUSTOM_PROTOCOL && (env.DECISION_CUSTOM_PROTOCOL !== 'cloudflare' || env.DECISION_CUSTOM_MODEL)) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_BASE_URL,
        protocolPath(env.DECISION_CUSTOM_PROTOCOL, env.DECISION_CUSTOM_MODEL));
    }
    const headers = customHeaders(env.DECISION_CUSTOM_HEADERS, env, endpoint, authEndpoint, reserved, live);
    return { model, protocol, endpoint, headers };
  }
  const selected = provider === 'typesafe' ? model ?? (env.TYPESAFE_MODEL?.trim() || 'jev-latest') : models[provider];
  const headers = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: 'Bearer ' + apiKey };
  return { model: selected, protocol: provider, endpoint: endpoints[provider], headers: live ? headers : {} };
}

const asText = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function openAIQuestion(name, { type, instructions, criteria }) {
  const text = asText(instructions);
  if (type === 'noul') {
    const rubric = criteria == null ? '' : '\nTrue/false criteria: ' + asText(criteria);
    return { type: 'predicate', name, instructions: text + rubric };
  }
  if (type === 'choice') {
    const choices = Object.entries(criteria).map(([value, description]) => ({
      value, ...(description == null ? {} : { description: asText(description) }),
    }));
    return { type, name, instructions: text, choices };
  }
  if (type !== 'score') throw new Error('Unsupported question type');
  const levels = criteria.map((description, index) => ({
    label: String(index), ...(description == null ? {} : { description: asText(description) }),
  }));
  return { type, name, instructions: text, levels };
}

function geminiQuestion({ type, instructions, criteria }) {
  const result = { type, instructions: asText(instructions) };
  if (type === 'noul') {
    if (criteria?.true != null || criteria?.false != null) {
      result.criteria = {};
      if (criteria.true != null) result.criteria.true_description = asText(criteria.true);
      if (criteria.false != null) result.criteria.false_description = asText(criteria.false);
    }
  } else if (type === 'choice') {
    result.criteria = Object.fromEntries(Object.entries(criteria).map(([id, value]) => [id, asText(value ?? id)]));
  } else if (type === 'score') {
    result.criteria = criteria.map((value, index) => asText(value ?? String(index)));
  } else {
    throw new Error('Unsupported question type');
  }
  return result;
}

function openAIAnswers(answers, entries) {
  if (!Array.isArray(answers) || answers.length !== entries.length) throw new Error('Invalid answers');
  const byName = new Map(answers.map(answer => [answer?.name, answer]));
  return Object.fromEntries(entries.map(([id, question], index) => {
    const answer = byName.get('q' + index);
    if (question.type === 'noul' && answer?.type === 'predicate') {
      return [id, { type: 'noul', noul: answer.probability }];
    }
    if (answer?.type !== question.type || !Array.isArray(answer.probabilities)) throw new Error('Invalid answer');
    const probabilities = new Map();
    for (const item of answer.probabilities) {
      const value = item?.value;
      const validKey = question.type === 'score' ? Number.isInteger(value) : typeof value === 'string';
      if (!validKey || probabilities.has(String(value))) throw new Error('Invalid probability key');
      probabilities.set(String(value), item.probability);
    }
    return [id, {
      type: answer.type, choice: answer.choice, score: answer.score,
      confidence: answer.confidence, probabilities: Object.fromEntries(probabilities),
    }];
  }));
}

export function decisionRequest(protocol, { state, model, questions }, limits) {
  const entries = Object.entries(questions);
  if (limits && (entries.length < 1 || entries.length > limits.questions ||
    entries.some(([, question]) => (question.type === 'choice' && Object.keys(question.criteria).length > limits.choices) ||
      (question.type === 'score' && question.criteria.length > limits.levels)))) {
    throw new Error('Question set exceeds provider limits');
  }
  if (protocol === 'systemone' || protocol === 'cloudflare') {
    if (protocol === 'systemone') return { state, model, questions };
    if (entries.length < 1 || entries.length > 64) throw new Error('Invalid question count');
    // Cloudflare restricts IDs to a short ASCII alphabet. Resolve generated IDs locally.
    return { state, model, questions: Object.fromEntries(entries.map(([, question], index) => ['q' + index, question])) };
  }
  const input = JSON.stringify(state);
  if (protocol === 'openai') {
    if (entries.length > 400) throw new Error('Too many questions');
    return {
      model, input, questions: entries.map(([, question], index) => openAIQuestion('q' + index, question)),
    };
  }
  if (entries.length > 1000) throw new Error('Too many questions');
  return {
    model, input, questions: Object.fromEntries(entries.map(([, question], index) => [
      'q' + index, geminiQuestion(question),
    ])),
  };
}

export function decisionResponse(protocol, response, questions) {
  const entries = Object.entries(questions);
  if (protocol === 'systemone') return response;
  if (protocol === 'cloudflare') {
    if (response?.success !== true || !record(response.result)) throw new Error('Invalid response envelope');
    response = response.result;
  }
  if (protocol === 'openai') {
    return { answers: openAIAnswers(response?.answers, entries), usage: response.usage };
  }
  if (response?.prompt_feedback?.block_reason || !record(response?.answers) ||
    Object.keys(response.answers).length !== entries.length) throw new Error('Invalid answers');
  return {
    answers: Object.fromEntries(entries.map(([id], index) => [id, response.answers['q' + index]])),
    usage: response.usage,
  };
}

export function pinnedFetch(endpoint, fetchImpl) {
  return async (url, init) => {
    if (url !== endpoint || init?.method !== 'POST') throw new Error('Invalid provider endpoint');
    const response = await fetchImpl(url, { ...init, redirect: 'error' });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('Provider redirect refused');
    }
    return response;
  };
}
