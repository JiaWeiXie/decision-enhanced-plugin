import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createClient, noul } from '../src/decision.mjs';
import { checkedLookup } from '../src/decision-custom.mjs';

const questions = { yes: noul('Is the fixture ready?') };
const state = { text: 'Synthetic input' };
const answer = { type: 'noul', noul: 0.7 };
const result = { answers: { yes: answer }, usage: { input_tokens: 3 } };
const account = 'a'.repeat(32);
const cloud = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_AUTH_TOKEN: 'synthetic-workers-bearer-token' };
const cloudEnv = { ...cloud, CLOUDFLARE_API_TOKEN: 'ignored', CLOUDFLARE_BASE_URL: 'https://ignored.invalid' };

for (const model of ['clef', 'clef-flash', 'clef-omni']) {
  test(`Cloudflare ${model} uses the pinned REST route and System One envelope`, async () => {
    const client = createClient({
      provider: 'cloudflare', env: cloudEnv, model: model === 'clef' ? undefined : model,
      fetchImpl: async (url, init) => {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`);
        assert.equal(init.headers.Authorization, 'Bearer synthetic-workers-bearer-token');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(JSON.parse(init.body), {
          state, model, questions: { q0: { type: 'noul', instructions: 'Is the fixture ready?' } },
        });
        return Response.json({ success: true, result: { ...result, answers: { q0: answer } }, messages: ['DO-NOT-ECHO'] });
      },
    });
    const output = await client.ask(state, questions);
    assert.deepEqual(output, { mode: 'live', provider: 'cloudflare', model, ...result });
  });
}

test('Cloudflare fails closed for bad account, unsupported model, over-cap and failed REST envelope', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return Response.json({ success: false, result: { answers: { q0: answer } }, errors: [{ message: 'DO-NOT-ECHO' }] });
  };
  assert.throws(() => createClient({ provider: 'cloudflare', env: { ...cloud, CLOUDFLARE_ACCOUNT_ID: '../bad' } }),
    { reason: 'invalid_provider_config' });
  assert.throws(() => createClient({ provider: 'cloudflare', env: cloud, model: 'invalid' }), { reason: 'invalid_provider_config' });
  assert.throws(() => createClient({ provider: 'cloudflare', env: {}, apiKey: 'ignored' }), { reason: 'missing_api_key' });
  const client = createClient({ provider: 'cloudflare', env: cloud, fetchImpl });
  await assert.rejects(client.ask(state, Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['q' + i, questions.yes]))),
    { reason: 'judgments_unavailable' });
  assert.equal(count, 0);
  await assert.rejects(client.ask(state, questions), { message: 'judgments_unavailable' });
  assert.equal(count, 1);
});

test('Ollama uses native System One without auth, only an explicit model can select cloud', async () => {
  for (const model of [undefined, 'clef:cloud']) {
    const client = createClient({
      provider: 'ollama', env: { OLLAMA_HOST: 'https://ignored.invalid', OPENAI_API_KEY: 'ignored-openai-auth' }, model,
      fetchImpl: async (url, init) => {
        assert.equal(url, 'http://localhost:11434/v1/systemone');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(init.body), { state, model: model ?? 'clef',
          questions: { yes: { type: 'noul', instructions: 'Is the fixture ready?' } } });
        return Response.json(result);
      },
    });
    const output = await client.ask(state, questions);
    assert.equal(output.model, model ?? 'clef');
    assert.deepEqual(output.answers, result.answers);
  }
  assert.throws(() => createClient({ provider: 'ollama', env: {}, model: 'other-model' }),
    { reason: 'invalid_provider_config' });
  assert.throws(() => createClient({ env: cloud }), { reason: 'missing_api_key' });
});

const customEnv = {
  DECISION_CUSTOM_ENDPOINT: 'https://decision.example.test/internal/evaluate',
  DECISION_CUSTOM_PROTOCOL: 'systemone',
  DECISION_CUSTOM_MODEL: 'local-engine/model',
};

test('custom binds explicit env-referenced HTTPS headers and rejects redirects', async () => {
  const env = {
    ...customEnv,
    DECISION_CUSTOM_HEADERS: '[["CF-Access-Client-Id","ACCESS_ID"],["CF-Access-Client-Secret","ACCESS_SECRET"]]',
    ACCESS_ID: 'synthetic-access-id',
    ACCESS_SECRET: 'synthetic-access-secret',
    OPENAI_API_KEY: 'unrelated-official-provider-key',
  };
  let calls = 0;
  const client = createClient({ provider: 'custom', env, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, customEnv.DECISION_CUSTOM_ENDPOINT);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['cf-access-client-id'], 'synthetic-access-id');
    assert.equal(init.headers['cf-access-client-secret'], 'synthetic-access-secret');
    assert.equal(init.headers.Authorization, undefined);
    return new Response(null, { status: 302, headers: { Location: 'https://redirect.example.test/' } });
  } });
  await assert.rejects(client.ask({ data: 'synthetic-access-secret' }, questions), { reason: 'unsafe_payload' });
  assert.equal(calls, 0);
  await assert.rejects(client.ask(state, questions), { reason: 'judgments_unavailable' });
  assert.equal(calls, 1);
});

test('custom rejects metadata, ambiguous URLs, credential inheritance, routing and malformed headers', () => {
  const invalid = [
    { DECISION_CUSTOM_ENDPOINT: 'https://metadata.google.internal./compute/' },
    { DECISION_CUSTOM_ENDPOINT: 'https://169.254.169.254/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://[fe80::1]/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://[fd00:ec2::254]/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://[::ffff:a9fe:a9fe]/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://1.2.3.4/route?' },
    { DECISION_CUSTOM_ENDPOINT: 'https://user:password@1.2.3.4/route' },
    { DECISION_CUSTOM_ENDPOINT: 'http://192.168.10.11/clef' },
    { DECISION_CUSTOM_BASE_URL: 'https://two.example.test' },
    { DECISION_CUSTOM_PROTOCOL: 'toString' },
    { DECISION_CUSTOM_HEADERS: '[["Authorization","OPENAI_API_KEY"]]', OPENAI_API_KEY: 'synthetic' },
    { DECISION_CUSTOM_HEADERS: '[["authorization","CUSTOM_AUTH"],["Authorization","CUSTOM_AUTH"]]', CUSTOM_AUTH: 'synthetic' },
    ...['Host', 'Connection', 'X-Forwarded-Host', 'X-Original-URL', 'Transfer-Encoding', 'Proxy-Authorization']
      .map(name => ({ DECISION_CUSTOM_HEADERS: JSON.stringify([[name, 'CUSTOM_AUTH']]), CUSTOM_AUTH: 'synthetic' })),
    { DECISION_CUSTOM_HEADERS: '[["Authorization","CUSTOM_AUTH"]]', CUSTOM_AUTH: 'synthetic\r\nInjected: yes' },
    { DECISION_CUSTOM_ENDPOINT: 'http://localhost:19007/v1/systemone',
      DECISION_CUSTOM_HEADERS: '[["Authorization","CUSTOM_AUTH"]]', CUSTOM_AUTH: 'synthetic' },
  ];
  for (const override of invalid) {
    assert.throws(() => createClient({ provider: 'custom', env: { ...customEnv, ...override } }),
      { reason: 'invalid_provider_config' });
  }
});

test('custom base points to the configured protocol and never inherits provider credentials', async () => {
  const cases = [
    ['systemone', '/v1/systemone', 'synthetic', result],
    ['openai', '/v1/decisions', 'synthetic', { answers: [{ name: 'q0', type: 'predicate', probability: 0.7 }] }],
    ['gemini', '/v1beta/decisions', 'synthetic', { answers: { q0: answer } }],
    ['cloudflare', '/ai/run/@cf/cloudflare/clef', 'clef',
      { success: true, result: { answers: { q0: answer } } }],
  ];
  for (const [protocol, suffix, model, fixture] of cases) {
    const env = {
      DECISION_CUSTOM_BASE_URL: 'https://192.168.10.11/service/',
      DECISION_CUSTOM_PROTOCOL: protocol,
      DECISION_CUSTOM_MODEL: model,
      OPENAI_API_KEY: 'unrelated-key',
      ...cloud,
    };
    const client = createClient({ provider: 'custom', env, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://192.168.10.11/service' + suffix);
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
      assert.equal(JSON.parse(init.body).model, model);
      return Response.json(fixture);
    } });
    assert.deepEqual((await client.ask(state, questions)).answers, result.answers);
  }
});

test('custom lookup rejects mixed metadata addresses and checks all localhost records', async () => {
  const resolve = (host, addresses) => new Promise((accept, reject) => {
    checkedLookup(host, { all: true }, (error, result) => error ? reject(error) : accept(result),
      (_host, options, callback) => {
        assert.equal(options.all, true);
        callback(null, addresses);
      });
  });
  const addresses = [{ address: '192.168.1.2', family: 4 }];
  assert.deepEqual(await resolve('fixture.lan', addresses), addresses);
  await assert.rejects(resolve('fixture.lan', [...addresses, { address: '169.254.1.2', family: 4 }]));
  await assert.rejects(resolve('localhost', addresses));
});

test('custom direct transport runs against a credential-free loopback fixture and refuses a redirected response', async t => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    if (req.url !== '/safe') {
      res.writeHead(307, { Location: '/safe' }).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const incoming = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(
      req.headers.authorization === undefined && incoming.state.text === 'Synthetic input' ? result : {},
    ));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const make = path => createClient({ provider: 'custom', env: {
    ...customEnv, DECISION_CUSTOM_ENDPOINT: `http://127.0.0.1:${server.address().port}/${path}`,
  } });
  assert.deepEqual((await make('safe').ask(state, questions)).answers, result.answers);
  await assert.rejects(make('redirect').ask(state, questions), { reason: 'judgments_unavailable' });
  assert.equal(calls, 2);
});

test('custom credential binding rejects CLI target switches and token strings in URL or request', async () => {
  const env = {
    ...customEnv, DECISION_CUSTOM_HEADERS: '[["Authorization","CUSTOM_AUTH"]]',
    CUSTOM_AUTH: 'Bearer synthetic-opaque-endpoint-key',
  };
  let requests = 0;
  const options = { provider: 'custom', env, fetchImpl: () => { requests++; return Response.json(result); } };
  assert.throws(() => createClient({ ...options, custom: { endpoint: 'https://another.example.test/evaluate' } }),
    { reason: 'invalid_provider_config' });
  assert.throws(() => createClient({ ...options, env: {
    ...env, DECISION_CUSTOM_HEADERS: '[["X_Forwarded_Host","CUSTOM_AUTH"]]',
  } }), { reason: 'invalid_provider_config' });
  await assert.rejects(createClient(options).ask({ text: 'synthetic-opaque-endpoint-key' }, questions),
    { reason: 'unsafe_payload' });
  const endpoint = 'https://decision.example.test/synthetic%2Dopaque-endpoint-key';
  const client = createClient({ ...options, env: { ...env, DECISION_CUSTOM_ENDPOINT: endpoint } });
  await assert.rejects(client.ask(state, questions), { reason: 'unsafe_payload' });
  await assert.rejects(createClient({ ...options, mode: 'dry-run' }).ask({ text: 'synthetic-opaque-endpoint-key' }, questions),
    { reason: 'unsafe_payload' });
  assert.equal(requests, 0);
});

test('structured credential fields are blocked before any network request', async () => {
  const client = createClient({ provider: 'ollama', env: {},
    fetchImpl: () => assert.fail('unsafe state reached transport'),
  });
  await assert.rejects(client.ask({ nested: { password: 'opaquefixturevalue123' } }, questions),
    { reason: 'unsafe_payload' });
});

test('the local Ollama choice and total question limits are enforced before any request', async () => {
  const client = createClient({ provider: 'ollama', env: {}, fetchImpl: () => assert.fail('oversized request sent') });
  const choices = Object.fromEntries(Array.from({ length: 27 }, (_, index) => ['option_' + index, 'fixture choice']));
  await assert.rejects(client.ask(state, { choose: { type: 'choice', instructions: 'Choose', criteria: choices } }),
    { reason: 'judgments_unavailable' });
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => ['question_' + index, questions.yes]));
  await assert.rejects(client.ask(state, many), { reason: 'judgments_unavailable' });
});
