export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const hasOnly = (value, allowed) => isRecord(value) && Object.keys(value).every(key => allowed.includes(key));
const invalidResponse = () => new Error('Invalid provider response');
const count = value => Number.isSafeInteger(value) && value >= 0;
const feedbackText = value => typeof value === 'string' && value.length <= 1024;

export function checkSystemOneResponse(response, cloudflare = false) {
  const fields = ['model', 'answers', 'usage'];
  if (!cloudflare) fields.push('feedback');
  if (!hasOnly(response, fields) || !isRecord(response.answers) ||
    typeof response.model !== 'string' || !hasOnly(response.usage, ['input_tokens', 'output_tokens']) ||
    !count(response.usage.input_tokens) || !count(response.usage.output_tokens) ||
    (response.feedback !== undefined && !feedbackText(response.feedback))) throw invalidResponse();
  return response;
}

export function checkGeminiResponse(response) {
  if (!hasOnly(response, ['answers', 'usage', 'prompt_feedback']) || !isRecord(response.answers)) throw invalidResponse();
  if (response.prompt_feedback !== undefined) {
    const feedback = response.prompt_feedback;
    if (!hasOnly(feedback, ['block_reason', 'block_reason_message']) ||
      feedback.block_reason !== undefined ||
      (feedback.block_reason_message !== undefined && !feedbackText(feedback.block_reason_message))) {
      throw invalidResponse();
    }
  }
  return response;
}

export function unwrapCloudflare(response) {
  if (!hasOnly(response, ['success', 'result', 'errors', 'messages']) || response.success !== true ||
    (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) ||
    (response.messages !== undefined && !validNotices(response.messages))) throw invalidResponse();
  return checkSystemOneResponse(response.result, true);
}

function validNotices(messages) {
  return Array.isArray(messages) && messages.length <= 16 && messages.every(item =>
    feedbackText(item) || (hasOnly(item, ['code', 'message', 'documentation_url']) &&
      (item.code === undefined || count(item.code)) &&
      (item.message === undefined || feedbackText(item.message)) &&
      (item.documentation_url === undefined || feedbackText(item.documentation_url))));
}

const usageFields = {
  systemone: ['input_tokens', 'output_tokens'],
  openai: ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'],
  gemini: ['total_input_tokens', 'initial_input_tokens', 'total_cached_tokens', 'total_thought_tokens',
    'total_output_tokens', 'total_tool_use_tokens', 'total_tokens', 'grounding_tool_count',
    'input_tokens_by_modality', 'output_tokens_by_modality', 'cached_tokens_by_modality', 'tool_use_tokens_by_modality'],
};

function countRecord(value, names) {
  return hasOnly(value, names) && Object.values(value).every(count);
}

export function normalizeUsage(usage, protocol) {
  if (usage === undefined) return null;
  const allowed = usageFields[protocol] ?? usageFields.systemone;
  if (!hasOnly(usage, allowed)) throw invalidResponse();
  const normalized = {};
  for (const [name, value] of Object.entries(usage)) {
    if (name.endsWith('_by_modality')) {
      if (!Array.isArray(value) || value.length > 16 || value.some(part => !hasOnly(part, ['modality', 'tokens']) ||
        typeof part.modality !== 'string' || !count(part.tokens))) throw invalidResponse();
    } else if (name === 'grounding_tool_count') {
      if (!Array.isArray(value) || value.length > 16 || value.some(item => !hasOnly(item, ['type', 'count']) ||
        !['google_search', 'google_maps'].includes(item.type) || !count(item.count))) throw invalidResponse();
    } else if (name === 'input_tokens_details') {
      if (!countRecord(value, ['cached_tokens', 'cache_write_tokens'])) throw invalidResponse();
    } else if (name === 'output_tokens_details') {
      if (!countRecord(value, ['reasoning_tokens'])) throw invalidResponse();
    } else {
      if (!count(value)) throw invalidResponse();
      normalized[name] = value;
    }
  }
  return normalized;
}

export function checkKeyedAnswer(answer, type, keys, probability, protocol) {
  const common = ['type', 'confidence'];
  if (type === 'noul') {
    return hasOnly(answer, protocol === 'cloudflare' ? ['type', 'noul'] : [...common, 'noul']) &&
      probability(answer.noul) &&
      (answer.confidence === undefined || probability(answer.confidence));
  }
  if (type === 'choice') return hasOnly(answer, [...common, 'choice', 'probabilities']);
  if (type !== 'score' || !hasOnly(answer, [...common, 'score', 'probabilities', 'legend'])) return false;
  if (answer.legend === undefined) return protocol !== 'cloudflare';
  return hasOnly(answer.legend, keys) && Object.keys(answer.legend).length === keys.length;
}
