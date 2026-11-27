import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, noul, choice, score, MissingApiKeyError } from '../src/jev.mjs';
import { ProviderError } from '../src/providers.mjs';

const state = { ticket: 'Synthetic ticket' };
const criteria = { true: { what: 'Named problem' }, false: 'Unrelated' };
const questions = {
  urgent: noul({ question: 'Is there an urgent problem?', inspect: 'ticket' }, criteria),
  team: choice('Which team?', { support: { what: 'User help' }, other: 'Other' }),
  severity: score('How severe?', ['Low', 'High']),
};
const answers = {
  urgent: { type: 'noul', noul: 0.25 },
  team: { type: 'choice', choice: 'support', probabilities: { support: 0.9, other: 0.1 }, confidence: 0.9 },
  severity: { type: 'score', score: 0.7, probabilities: { 0: 0.3, 1: 0.7 }, confidence: 0.8 },
};
const usage = { input_tokens: 12, output_tokens: 0 };
const mappedQuestions = {
  urgent: { type: 'noul', instructions: JSON.stringify(questions.urgent.instructions),
    criteria: { true: '{"what":"Named problem"}', false: 'Unrelated' } },
  team: { type: 'choice', instructions: 'Which team?', criteria: { support: '{"what":"User help"}', other: 'Other' } },
  severity: { type: 'score', instructions: 'How severe?', criteria: ['Low', 'High'] },
};
const openAIAnswers = [
  { name: 'severity', type: 'score', score: 0.7, confidence: 0.8,
    probabilities: [{ value: 1, label: '1', probability: 0.7 }, { value: 0, label: '0', probability: 0.3 }] },
  { name: 'urgent', type: 'predicate', probability: 0.25 },
  { name: 'team', type: 'choice', choice: 'support', confidence: 0.9,
    probabilities: [{ value: 'support', probability: 0.9 }, { value: 'other', probability: 0.1 }] },
];
const accountId = '0123456789abcdef0123456789abcdef';

for (const fixture of [
  {
    options: { provider: 'openai' },
    endpoint: 'https://api.openai.com/v1/decisions',
    body: { model: 'gpt-6-luna', input: JSON.stringify(state), questions: [
      { name: 'urgent', type: 'predicate',
        instructions: `${mappedQuestions.urgent.instructions}\nYes/no criteria: ${JSON.stringify(criteria)}` },
      { name: 'team', type: 'choice', instructions: 'Which team?', choices: [
        { value: 'support', description: '{"what":"User help"}' }, { value: 'other', description: 'Other' },
      ] },
      { name: 'severity', type: 'score', instructions: 'How severe?', levels: [
        { label: '0', description: 'Low' }, { label: '1', description: 'High' },
      ] },
    ] },
    response: { answers: openAIAnswers, usage },
  },
  {
    options: { provider: 'gemini' },
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/decisions',
    body: { model: 'gemini-decision-1', input: JSON.stringify(state), questions: {
      ...mappedQuestions, urgent: { ...mappedQuestions.urgent,
        criteria: { true_description: '{"what":"Named problem"}', false_description: 'Unrelated' } },
    } },
    response: { answers: { ...answers, urgent: { ...answers.urgent, confidence: 0.75 } },
      usage: { total_input_tokens: 12, total_output_tokens: 0 } },
  },
  {
    options: { provider: 'cloudflare', model: '@cf/cloudflare/clef-flash', accountId },
    endpoint: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`,
    body: { model: 'clef-flash', state, questions: mappedQuestions },
    response: { success: true, result: { answers, usage }, errors: [], messages: [] },
  },
  {
    options: { provider: 'opencode' },
    endpoint: 'https://opencode.ai/inference/systemone/v1/systemone',
    body: { model: 'jev-1.14', state, questions: mappedQuestions },
    response: { answers, usage },
  },
  {
    options: { provider: 'ollama-cloud' },
    endpoint: 'https://ollama.com/v1/systemone',
    body: { model: 'clef', state, questions: mappedQuestions },
    response: { answers, usage },
  },
  {
    options: { provider: 'self-hosted', format: 'system-one', baseUrl: 'https://fixture.invalid/prefix/', model: 'nimble' },
    endpoint: 'https://fixture.invalid/prefix/v1/systemone',
    body: { model: 'nimble', state, questions: mappedQuestions },
    response: { answers, usage },
  },
]) {
  const { options, endpoint, body, response } = fixture;
  test(`${options.provider} sends the documented decision request and reads typed results`, async () => {
    let calls = 0;
    const client = createClient({ ...options, apiKey: 'fixture-key', fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.ok(request.signal instanceof AbortSignal);
      assert.deepEqual(request.headers, {
        'content-type': 'application/json',
        ...(options.provider === 'gemini' ? { 'x-goog-api-key': 'fixture-key' } : { authorization: 'Bearer fixture-key' }),
      });
      assert.deepEqual(JSON.parse(request.body), body);
      return Response.json(response);
    } });
    const result = await client.ask(state, questions);
    assert.equal(calls, 1);
    assert.equal(result.mode, 'live');
    assert.equal(result.provider, options.provider);
    assert.equal(result.model, body.model);
    assert.deepEqual(result.answers, answers);
    assert.deepEqual(result.usage, response.usage ?? response.result.usage);
  });
}

test('TypeSafe retains its original wire payload and no provider option is inferred from other keys', async () => {
  const client = createClient({ apiKey: 'fixture-key', model: 'legacy-test', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.deepEqual(JSON.parse(request.body), { model: 'legacy-test', state, questions });
    return Response.json({ answers, model: 'legacy-test', usage });
  } });
  assert.deepEqual(await client.ask(state, questions), { answers, model: 'legacy-test', usage, mode: 'live' });
});

test('TypeSafe refuses redirects without retrying or emitting response details', async () => {
  const requests = [];
  const client = createClient({ apiKey: 'fixture-key', fetchImpl: async (_url, request) => {
    requests.push(request.redirect);
    return new Response('fixture-private', { status: 307, headers: { location: 'https://fixture.invalid/' } });
  } });
  await assert.rejects(client.ask(state, questions), { message: 'TypeSafe request failed' });
  assert.deepEqual(requests, ['error']);
});

test('fixed-model decision APIs reject a generation model before a request', () => {
  for (const [provider, supported] of [['openai', 'gpt-6-luna'], ['gemini', 'gemini-decision-1']]) {
    assert.throws(() => createClient({ provider, model: 'general-chat', mode: 'dry-run' }),
      new RegExp(supported));
    assert.doesNotThrow(() => createClient({ provider, model: supported, mode: 'dry-run' }));
  }
});

test('hosted decision requests reject documented question and rubric limits before fetch', async () => {
  const many = (count, value) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, value]));
  for (const [provider, limit] of [['openai', 400], ['gemini', 1000], ['cloudflare', 64], ['ollama-cloud', 64]]) {
    let calls = 0;
    const client = createClient({ provider, accountId, apiKey: 'fixture-key',
      fetchImpl: async () => { calls++; return Response.json({ answers }); } });
    await assert.rejects(client.ask(state, many(limit + 1, questions.urgent)), new RegExp(String(limit)));
    assert.equal(calls, 0);
    const preview = createClient({ provider, accountId, mode: 'dry-run' });
    assert.equal((await preview.ask(state, many(limit, questions.urgent))).mode, 'dry-run');
  }
  for (const [provider, choices, levels] of [['openai', 255, 10], ['gemini', 255, 255], ['ollama-cloud', 26, 10]]) {
    const client = createClient({ provider, mode: 'dry-run' });
    await assert.rejects(client.ask(state, { team: choice('Which team?', many(choices + 1, 'A team')) }),
      new RegExp(String(choices)));
    await assert.rejects(client.ask(state, { severity: score('How severe?', Array(levels + 1).fill('Level')) }),
      new RegExp(String(levels)));
  }
});

const selfHosted = { provider: 'self-hosted', baseUrl: 'http://127.0.0.1:11434', model: 'fixture-model', apiKey: '' };
const suggestions = { urgent: false, team: 'support', severity: 1 };
for (const [format, path, response] of [
  ['openai-chat', '/v1/chat/completions',
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(suggestions) } }] }],
  ['ollama-chat', '/api/chat', { done: true, message: { content: JSON.stringify(suggestions) } }],
]) {
  test(`${format} uses its own protocol and keeps generated suggestions out of typed answers`, async () => {
    const client = createClient({ ...selfHosted, format, fetchImpl: async (url, request) => {
      assert.equal(url, selfHosted.baseUrl + path);
      assert.equal(request.headers.authorization, undefined);
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.stream, false);
      if (format === 'openai-chat') {
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
      }
      const schema = format === 'ollama-chat' ? body.format : body.response_format.json_schema.schema;
      assert.deepEqual(schema, { type: 'object', properties: {
        urgent: { type: ['boolean', 'null'] },
        team: { type: ['string', 'null'], enum: ['support', 'other', null] },
        severity: { type: ['integer', 'null'], enum: [0, 1, null] },
      }, required: ['urgent', 'team', 'severity'], additionalProperties: false });
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'user');
      assert.deepEqual(JSON.parse(body.messages[1].content), { state, questions });
      return Response.json(response);
    } });
    const result = await client.ask(state, questions);
    assert.equal(result.mode, 'chat-advisory');
    assert.equal(result.answers, null);
    assert.deepEqual(result.suggestions, suggestions);
  });
}

test('hosted credentials never substitute for the selected provider key', () => {
  for (const [provider, variable] of [
    ['openai', 'OPENAI_API_KEY'], ['gemini', 'GEMINI_API_KEY'], ['cloudflare', 'CLOUDFLARE_API_TOKEN'],
    ['opencode', 'OPENCODE_API_KEY'], ['ollama-cloud', 'OLLAMA_API_KEY'],
  ]) {
    assert.throws(() => createClient({ provider, accountId, apiKey: '' }),
      error => error instanceof MissingApiKeyError && error.message === `${variable} is not set`);
  }
});

test('only explicitly selected self-hosted endpoints may choose a URL and API format', () => {
  assert.throws(() => createClient({ provider: 'gemini', baseUrl: 'https://fixture.invalid' }), /self-hosted/);
  assert.throws(() => createClient({ ...selfHosted, format: 'toString' }), /--api-format/);
  for (const baseUrl of [
    'file:///tmp/fixture', 'http://fixture.invalid', 'https:/fixture.invalid',
    'https://user:secret@fixture.invalid', 'https://@fixture.invalid', 'https://fixture.invalid/?',
    'https://fixture.invalid/#', ' https://fixture.invalid', 'http://127.0.0.1\\@fixture.invalid',
  ]) {
    assert.throws(() => createClient({ ...selfHosted, format: 'system-one', baseUrl }), /^TypeError: --base-url/);
  }
  assert.throws(() => createClient({ provider: 'cloudflare', accountId: '../fixture' }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(() => createClient({ provider: 'cloudflare', accountId, model: 'clef/../fixture' }), /models supported/);
});

test('provider dry-run previews the actual wire body without credentials or fetch', async () => {
  const client = createClient({ provider: 'gemini', mode: 'dry-run', apiKey: 'fixture-key',
    fetchImpl: () => assert.fail('dry-run made a request') });
  const preview = await client.ask(state, questions);
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.request.input, JSON.stringify(state));
  assert.equal(preview.answers, null);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-key|x-goog-api-key/);
});

test('OpenAI refuses duplicate, missing, refused, or invalid typed answers', async () => {
  for (const altered of [
    [openAIAnswers[0], openAIAnswers[1], openAIAnswers[1]],
    openAIAnswers.slice(1),
    [{ name: 'severity', type: 'refusal' }, ...openAIAnswers.slice(1)],
    [{ ...openAIAnswers[0], score: 3 }, ...openAIAnswers.slice(1)],
    [...openAIAnswers.slice(0, 2), { ...openAIAnswers[2],
      probabilities: [openAIAnswers[2].probabilities[0], openAIAnswers[2].probabilities[0]] }],
  ]) {
    const client = createClient({ provider: 'openai', apiKey: 'fixture-key',
      fetchImpl: async () => Response.json({ answers: altered }) });
    await assert.rejects(client.ask(state, questions), ProviderError);
  }
});

test('chat rejects invalid labels, numeric predicates, truncated output and extra questions', async () => {
  for (const response of [
    { done: true, message: { content: JSON.stringify({ ...suggestions, team: 'invented' }) } },
    { done: true, message: { content: JSON.stringify({ ...suggestions, urgent: 0.9 }) } },
    { done: true, message: { content: JSON.stringify({ ...suggestions, extra: true }) } },
    { done: true, done_reason: 'length', message: { content: JSON.stringify(suggestions) } },
  ]) {
    const client = createClient({ ...selfHosted, format: 'ollama-chat', fetchImpl: async () => Response.json(response) });
    await assert.rejects(client.ask(state, questions), ProviderError);
  }
});

test('failure, redirection and the response-size limit produce no retry or raw-body diagnostics', async () => {
  for (const mock of [
    () => new Response('fixture-private', { status: 429 }),
    () => new Response('fixture-private', { status: 307, headers: { location: 'https://fixture.invalid/' } }),
    () => new Response('fixture-private'.repeat(340_000)),
    () => Response.json({ success: false, result: { answers }, errors: ['fixture-private'] }),
    () => Promise.reject(new Error('fixture-private')),
  ]) {
    let calls = 0;
    const client = createClient({ provider: 'cloudflare', accountId, apiKey: 'fixture-key',
      fetchImpl: async () => { calls++; return mock(); } });
    await assert.rejects(client.ask(state, questions), error =>
      error instanceof ProviderError && !error.message.includes('fixture-private'));
    assert.equal(calls, 1);
  }
});

test('cloud question ID constraints do not change the pack question IDs', async () => {
  const original = { 'décision 1': questions.urgent, q1: questions.team };
  for (const provider of ['cloudflare', 'ollama-cloud']) {
    const options = { provider, accountId, apiKey: 'fixture-key' };
    const client = createClient({ ...options, fetchImpl: async (_url, request) => {
      assert.deepEqual(JSON.parse(request.body).questions, { q1: mappedQuestions.urgent, q2: mappedQuestions.team });
      const result = { answers: { q2: answers.team, q1: answers.urgent } };
      return Response.json(provider === 'cloudflare' ? { success: true, result } : result);
    } });
    const preview = await createClient({ ...options, mode: 'dry-run' }).ask(state, original);
    assert.deepEqual(preview.questionIds, { 'décision 1': 'q1', q1: 'q2' });
    assert.deepEqual((await client.ask(state, original)).answers, { 'décision 1': answers.urgent, q1: answers.team });
  }
});

test('Gemini remaps invalid question IDs without collisions and preserves valid batches', async () => {
  const client = createClient({ provider: 'gemini', mode: 'dry-run' });
  const valid = 'a'.repeat(64);
  const unchanged = await client.ask(state, { [valid]: questions.urgent, 'valid-ID_2': questions.urgent });
  assert.deepEqual(Object.keys(unchanged.request.questions), [valid, 'valid-ID_2']);
  assert.equal(unchanged.questionIds, undefined);

  for (const invalid of ['phase 1', '階段二', 'phase.3', 'x'.repeat(65)]) {
    const preview = await client.ask(state, { [invalid]: questions.urgent, q1: questions.team });
    assert.deepEqual(Object.keys(preview.request.questions), ['q1', 'q2']);
    assert.deepEqual(preview.questionIds, { [invalid]: 'q1', q1: 'q2' });
  }
});

test('Gemini option IDs respect character and byte boundaries and preserve valid siblings', async () => {
  const client = createClient({ provider: 'gemini', mode: 'dry-run' });
  const valid = ['內 部', 'x'.repeat(128), '🙂'.repeat(128), 'option_1', 'option_2', '__proto__', 'constructor'];
  const invalid = ['', ' pad', 'pad ', 'a\u00a0b', 'a\u2003b', 'a\u0000b', 'a\u007fb', 'a\nb', '\ud800',
    'x'.repeat(129), '🙂'.repeat(129)];
  for (const id of invalid) {
    const criteria = Object.fromEntries([...valid, id].map((key, index) => [key, `criterion ${index}`]));
    const preview = await client.ask(state, { choose: choice('Which?', criteria) });
    assert.deepEqual(preview.request.questions.choose.criteria, {
      ...Object.fromEntries(valid.map(key => [key, criteria[key]])), option_3: criteria[id],
    });
  }

  const validCriteria = Object.fromEntries(valid.map(key => [key, 'description']));
  const validQuestions = { choose: choice('Which?', validCriteria) };
  const preview = await client.ask(state, validQuestions);
  assert.deepEqual(preview.request.questions, validQuestions);
  assert.equal(preview.optionIds, undefined);

  const defaultPreview = await createClient({ mode: 'dry-run' }).ask(state, {
    choose: choice('Which?', { ' padded ': 'description', option_1: 'another' }),
  });
  assert.deepEqual(defaultPreview.request.questions.choose.criteria,
    { ' padded ': 'description', option_1: 'another' });
});

test('Gemini scopes option aliases to each wire question and restores both kinds of ID', async () => {
  const original = {
    'bad question': choice('First?', { ' one ': 'First criterion', option_1: 'Other' }),
    q1: choice('Second?', { ' two ': 'Second criterion', ' also invalid ': 'Third criterion' }),
  };
  const options = { provider: 'gemini', apiKey: 'fixture-key' };
  const preview = await createClient({ ...options, mode: 'dry-run' }).ask(state, original);
  assert.deepEqual(preview.questionIds, { 'bad question': 'q1', q1: 'q2' });
  assert.deepEqual(preview.optionIds, { q1: { ' one ': 'option_2' }, q2: { ' two ': 'option_1', ' also invalid ': 'option_2' } });
  const client = createClient({ ...options, fetchImpl: async () => Response.json({ answers: {
    q2: { type: 'choice', choice: 'option_1', confidence: 0.8, probabilities: { option_2: 0.2, option_1: 0.8 } },
    q1: { type: 'choice', choice: 'option_2', confidence: 0.9, probabilities: { option_1: 0.1, option_2: 0.9 } },
  } }) });
  assert.deepEqual((await client.ask(state, original)).answers, {
    'bad question': { type: 'choice', choice: ' one ', confidence: 0.9, probabilities: { option_1: 0.1, ' one ': 0.9 } },
    q1: { type: 'choice', choice: ' two ', confidence: 0.8, probabilities: { ' also invalid ': 0.2, ' two ': 0.8 } },
  });
});

test('Gemini rejects choices or probability keys that were absent from the request', async () => {
  const q = { team: choice('Which team?', { ' padded ': 'First criterion', other: 'Other' }) };
  for (const answer of [
    { choice: ' padded ', probabilities: { option_1: 0.75, other: 0.25 } },
    { choice: 'option_1', probabilities: { ' padded ': 0.75, other: 0.25 } },
    { choice: 'option_1', probabilities: { option_1: 0.75, other: 0.25, ' padded ': 0 } },
    { choice: 'option_1', probabilities: { option_1: 1 } },
  ]) {
    const client = createClient({ provider: 'gemini', apiKey: 'fixture-key', fetchImpl: async () =>
      Response.json({ answers: { team: { type: 'choice', confidence: 0.75, ...answer } } }) });
    await assert.rejects(client.ask(state, q), ProviderError);
  }
});
