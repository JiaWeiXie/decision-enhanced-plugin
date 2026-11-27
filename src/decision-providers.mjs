import { customEndpoint, customHeaderBindings } from './decision-custom.mjs';
import { checkGeminiResponse, checkSystemOneResponse, hasOnly, isRecord, unwrapCloudflare } from './decision-response.mjs';

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
  gemini: ['GEMINI_API_KEY'],
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
      endpoint: live ? 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account) + cloudflarePath(model) : null,
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
    let authEndpoint;
    if (env.DECISION_CUSTOM_AUTH_ENDPOINT !== undefined) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_AUTH_ENDPOINT);
    } else if (env.DECISION_CUSTOM_ENDPOINT) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_ENDPOINT);
    } else if (env.DECISION_CUSTOM_BASE_URL &&
      env.DECISION_CUSTOM_PROTOCOL && (env.DECISION_CUSTOM_PROTOCOL !== 'cloudflare' || env.DECISION_CUSTOM_MODEL)) {
      authEndpoint = customEndpoint(env.DECISION_CUSTOM_BASE_URL,
        protocolPath(env.DECISION_CUSTOM_PROTOCOL, env.DECISION_CUSTOM_MODEL));
    }
    const bindings = customHeaderBindings(env, endpoint, authEndpoint);
    return { model, protocol, endpoint, bindings };
  }
  const selected = provider === 'typesafe' ? model ?? (env.TYPESAFE_MODEL?.trim() || 'jev-latest') : models[provider];
  const headers = provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: 'Bearer ' + apiKey };
  return { model: selected, protocol: provider, endpoint: endpoints[provider], headers: live ? headers : {} };
}

const asText = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

function checkOpenAIInput(state) {
  const invalidInput = () => new Error('Invalid OpenAI JSON evidence');
  if (!isRecord(state) && !(Array.isArray(state) && state.every(isRecord))) throw invalidInput();

  // Count the root and each nested value, including arrays and objects, but not property names.
  let values = 0;
  function visit(value, level) {
    if (++values > 10_000) throw invalidInput();
    if (value === null || typeof value !== 'object') return;
    if (level > 32) throw invalidInput();
    for (const child of Object.values(value)) visit(child, level + 1);
  }
  visit(state, 1);
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 256 * 1024) throw invalidInput();
}

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
    if (question.type === 'noul' && answer?.type === 'predicate' &&
      hasOnly(answer, ['type', 'name', 'probability'])) return [id, { type: 'noul', noul: answer.probability }];
    const selectedField = question.type === 'score' ? 'score' : 'choice';
    if (answer?.type !== question.type || !hasOnly(answer, ['type', 'name', 'probabilities', 'confidence', selectedField]) ||
      !Array.isArray(answer.probabilities)) throw new Error('Invalid answer');
    const probabilities = new Map();
    for (const item of answer.probabilities) {
      const value = item?.value;
      const score = question.type === 'score';
      const validKey = score ? Number.isInteger(value) && typeof item.label === 'string' : typeof value === 'string';
      if (!validKey || !hasOnly(item, score ? ['value', 'probability', 'label'] : ['value', 'probability']) ||
        probabilities.has(String(value))) throw new Error('Invalid probability key');
      probabilities.set(String(value), item.probability);
    }
    return [id, {
      type: answer.type, [selectedField]: answer[selectedField],
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
  if (protocol === 'openai') {
    if (entries.length > 400) throw new Error('Too many questions');
    checkOpenAIInput(state);
    return {
      model,
      input: [{ role: 'user', content: [{ type: 'input_json', data: state }] }],
      prompt_cache_options: { mode: 'explicit' },
      questions: entries.map(([, question], index) => openAIQuestion('q' + index, question)),
    };
  }
  if (entries.length > 1000) throw new Error('Too many questions');
  return {
    model, input: JSON.stringify(state), questions: Object.fromEntries(entries.map(([, question], index) => [
      'q' + index, geminiQuestion(question),
    ])),
  };
}

export function decisionResponse(protocol, response, questions) {
  const entries = Object.entries(questions);
  if (protocol === 'systemone' || protocol === 'typesafe') return checkSystemOneResponse(response);
  if (protocol === 'openai') {
    if (!hasOnly(response, ['answers', 'model', 'usage']) || typeof response.model !== 'string' ||
      !Number.isSafeInteger(response.usage?.input_tokens) || !Number.isSafeInteger(response.usage?.output_tokens)) {
      throw new Error('Invalid response');
    }
    return { answers: openAIAnswers(response.answers, entries), usage: response.usage };
  }
  response = protocol === 'cloudflare' ? unwrapCloudflare(response) : checkGeminiResponse(response);
  if (Object.keys(response.answers).length !== entries.length) throw new Error('Invalid answers');
  return {
    answers: Object.fromEntries(entries.map(([id], index) => [id, response.answers['q' + index]])),
    usage: response.usage,
  };
}
