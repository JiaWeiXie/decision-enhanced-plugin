import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, noul, choice, score } from '../src/decision.mjs';

const questions = {
  supported: noul({ question: 'Is the claim supported?' }, { true: { what: 'Verified' }, false: 'Unverified' }),
  path: choice('Choose a path', { local: { description: 'Keep locally' }, review: 'Ask for review' }),
  severity: score('Rate severity', ['Low', 'Medium', 'High']),
};
const state = { claim: 'Sample observation', evidence: 'Sample evidence' };
const answers = {
  supported: { type: 'noul', noul: 0.8 },
  path: { type: 'choice', choice: 'local', confidence: 0.75, probabilities: { local: 0.75, review: 0.25 } },
  severity: { type: 'score', score: 1.2, confidence: 0.6, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 } },
};
const openAI = {
  model: 'gpt-6-luna',
  answers: [
    { name: 'q2', type: 'score', score: 1.2, confidence: 0.6,
      probabilities: [{ value: 0, label: '0', probability: 0.2 }, { value: 1, label: '1', probability: 0.4 }, { value: 2, label: '2', probability: 0.4 }] },
    { name: 'q0', type: 'predicate', probability: 0.8 },
    { name: 'q1', type: 'choice', choice: 'local', confidence: 0.75,
      probabilities: [{ value: 'local', probability: 0.75 }, { value: 'review', probability: 0.25 }] },
  ],
  usage: { input_tokens: 42, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
};
const gemini = {
  answers: { q0: { ...answers.supported, confidence: 0.81 }, q1: answers.path, q2: answers.severity },
  usage: { total_input_tokens: 42, total_output_tokens: 0, input_tokens_by_modality: [{ modality: 'text', tokens: 42 }] },
};
const clients = {
  typesafe: {
    key: 'TYPESAFE_API_KEY', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest',
    response: { answers, model: 'jev-version', usage: { input_tokens: 42, output_tokens: 0 }, feedback: '<script>PROVIDER-ONLY</script>' },
  },
  openai: {
    key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', response: openAI,
  },
  gemini: {
    key: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/decisions',
    model: 'gemini-decision-1', response: gemini,
  },
};

for (const [provider, fixture] of Object.entries(clients)) {
  test(`${provider} uses the documented wire format and returns the same typed answers`, async () => {
    let requests = 0;
    const client = createClient({
      provider, env: { [fixture.key]: 'fixture-key', OPENAI_BASE_URL: 'http://invalid',
        GOOGLE_GEMINI_BASE_URL: 'http://invalid', TYPESAFE_BASE_URL: 'http://invalid' },
      fetchImpl: async (url, init) => {
        requests++;
        assert.equal(url, fixture.url);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('content-type'), 'application/json');
        if (provider === 'gemini') {
          assert.equal(headers.get('x-goog-api-key'), 'fixture-key');
          assert.equal(headers.get('authorization'), null);
        } else assert.equal(headers.get('authorization'), 'Bearer fixture-key');
        const body = JSON.parse(init.body);
        assert.equal(body.model, fixture.model);
        if (provider === 'typesafe') {
          assert.deepEqual(body, { state, model: fixture.model, questions });
        } else if (provider === 'openai') {
          assert.deepEqual(JSON.parse(body.input), state);
          assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
          assert.equal(body.prompt_cache_key, undefined);
          assert.deepEqual(body.questions.map(question => [question.name, question.type]), [
            ['q0', 'predicate'], ['q1', 'choice'], ['q2', 'score'],
          ]);
          assert.match(body.questions[0].instructions, /Unverified/);
          assert.deepEqual(body.questions[1].choices, [
            { value: 'local', description: '{"description":"Keep locally"}' }, { value: 'review', description: 'Ask for review' },
          ]);
          assert.deepEqual(body.questions[2].levels[2], { label: '2', description: 'High' });
        } else {
          assert.deepEqual(JSON.parse(body.input), state);
          assert.deepEqual(body.questions.q0.criteria, { true_description: '{"what":"Verified"}', false_description: 'Unverified' });
          assert.deepEqual(body.questions.q1.criteria, { local: '{"description":"Keep locally"}', review: 'Ask for review' });
          assert.deepEqual(body.questions.q2.criteria, ['Low', 'Medium', 'High']);
        }
        return Response.json(fixture.response);
      },
    });
    const result = await client.ask(state, questions);
    assert.deepEqual(result.answers, answers);
    assert.equal(result.provider, provider);
    assert.equal(result.model, provider === 'typesafe' ? 'jev-version' : fixture.model);
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-key|PROVIDER-ONLY|Sample observation/);
  });

  test(`${provider} blocks secrets before network and does not follow redirects`, async () => {
    let requests = 0;
    const client = createClient({
      provider, env: { [fixture.key]: 'configured-key-fixture' }, fetchImpl: async () => {
        requests++;
        return new Response(null, { status: 307, headers: { Location: 'https://example.invalid/' } });
      },
    });
    for (const [input, checks] of [
      [{ text: 'configured-key-fixture' }, questions],
      [{ text: '-----BEGIN OPENSSH PRIVATE KEY-----' }, questions],
      [state, { path: choice('Choose', { selected: 'password: "SyntheticValue123456"', other: 'Empty' }) }],
    ]) {
      await assert.rejects(client.ask(input, checks), { reason: 'unsafe_payload' });
      assert.equal(requests, 0);
    }
    await assert.rejects(client.ask(state, questions), { reason: 'judgments_unavailable' });
    assert.equal(requests, 1);
  });
}

test('auto selects one provider in compatibility order and does not fail over', async () => {
  const candidates = [
    [{ TYPESAFE_API_KEY: 'first', OPENAI_API_KEY: 'second', GEMINI_API_KEY: 'third' }, 'typesafe'],
    [{ OPENAI_API_KEY: 'second', GEMINI_API_KEY: 'third' }, 'openai'],
    [{ GOOGLE_API_KEY: 'alias' }, 'gemini'],
  ];
  for (const [env, expected] of candidates) {
    const calls = [];
    const client = createClient({ env: { ...env, DECISION_PROVIDER: 'auto' }, fetchImpl: async url => {
      calls.push(url);
      return new Response('DO-NOT-ECHO', { status: 429 });
    } });
    await assert.rejects(client.ask(state, questions), error => error.status === 429 && error.message === 'judgments_unavailable');
    assert.deepEqual(calls, [clients[expected].url]);
  }
  assert.throws(() => createClient({ provider: 'openai', env: { TYPESAFE_API_KEY: 'first' } }), { reason: 'missing_api_key' });
  assert.throws(() => createClient({ provider: 'fixture-unrecognized', env: {} }), { reason: 'unknown_provider' });
});

test('provider refusals, duplicate names, invalid distributions and non-JSON remain unavailable', async () => {
  const badOpenAI = [
    { ...openAI, answers: [openAI.answers[0], openAI.answers[1], openAI.answers[1]] },
    { ...openAI, answers: [openAI.answers[0], { name: 'q0', type: 'refusal', detail: 'DO-NOT-ECHO' }, openAI.answers[2]] },
    { ...openAI, answers: [openAI.answers[0], openAI.answers[1], { ...openAI.answers[2], choice: 'foreign' }] },
  ];
  const badGemini = [
    { answers: {}, prompt_feedback: { block_reason: 'safety', block_reason_message: 'DO-NOT-ECHO' } },
    { ...gemini, answers: { ...gemini.answers, q2: { ...answers.severity, score: 3 } } },
    { ...gemini, answers: { ...gemini.answers, q1: { ...answers.path, probabilities: { local: 0.9, review: 0.9 } } } },
  ];
  for (const [provider, responses] of [['openai', badOpenAI], ['gemini', badGemini]]) {
    for (const response of [...responses, null]) {
      const client = createClient({ provider, apiKey: 'fixture-key',
        fetchImpl: async () => response ? Response.json(response) : new Response('DO-NOT-ECHO'),
      });
      await assert.rejects(client.ask(state, questions), { message: 'judgments_unavailable' });
    }
  }
});

test('implicit TypeSafe selection never falls through to keys for another provider', async () => {
  const fetchImpl = () => assert.fail('non-TypeSafe transport requested');
  for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const env = { [name]: 'synthetic-credential-for-' + name };
    assert.throws(() => createClient({ env, fetchImpl }), { reason: 'missing_api_key' });
    const preview = await createClient({ mode: 'dry-run', env, fetchImpl }).ask(state, questions);
    assert.equal(preview.provider, 'typesafe');
    assert.equal(preview.request.model, 'jev-latest');
  }
});

test('Gemini guide rounding is accepted without rewriting or inventing probabilities', async () => {
  // https://aistudio.google.com/docs/decisions-api#score
  const rounded = { 0: 0.03, 1: 0.83, 2: 0.15 };
  const expected = { type: 'score', score: 1.12, confidence: 0.83, probabilities: rounded };
  const run = probabilities => createClient({ provider: 'gemini', apiKey: 'fixture-key', env: {},
    fetchImpl: () => Response.json({ answers: { q0: { ...expected, probabilities } } }),
  }).ask(state, { severity: questions.severity });
  assert.deepEqual((await run(rounded)).answers.severity, expected);
  const replay = await createClient({ mode: 'mock', provider: 'gemini', env: {}, mockAnswers: { severity: expected } })
    .ask(state, { severity: questions.severity });
  assert.equal(replay.mode, 'mock');
  assert.deepEqual(replay.answers.severity, expected);
  await assert.rejects(run({ 0: 0.03, 1: 0.84, 2: 0.15 }), { reason: 'judgments_unavailable' });
  await assert.rejects(run({ 0: 0.03, 1: 0.97 }), { reason: 'judgments_unavailable' });
  await assert.rejects(run({ 0: 0.03, 1: 0.83, unknown: 0.14 }), { reason: 'judgments_unavailable' });
});

test('Gemini 400 drops provider error text', async () => {
  const client = createClient({ provider: 'gemini', apiKey: 'fixture-key', env: {},
    fetchImpl: () => Response.json({ error: { message: 'DO-NOT-ECHO' } }, { status: 400 }),
  });
  await assert.rejects(client.ask(state, questions),
    { reason: 'judgments_unavailable', message: 'judgments_unavailable', status: 400 });
});
