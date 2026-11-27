import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createClient, noul } from '../src/decision.mjs';
import { directFetch, pinnedFetch } from '../src/decision-transport.mjs';
import { checkedLookup, customEndpoint } from '../src/decision-custom.mjs';

const questions = { yes: noul('Is the fixture ready?') };
const state = { text: 'Synthetic input' };
const answer = { type: 'noul', noul: 0.7 };
const result = { answers: { yes: answer }, usage: { input_tokens: 3, output_tokens: 0 }, model: 'fixture-contract-model' };
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
        return Response.json({ success: true, result: { ...result, model, answers: { q0: answer } }, messages: ['DO-NOT-ECHO'] });
      },
    });
    const output = await client.ask(state, questions);
    assert.deepEqual(output.answers, result.answers);
    assert.deepEqual(output.usage, result.usage);
    assert.deepEqual(output.decision, { id: output.decision.id, provider: 'cloudflare',
      model, origin: 'https://api.cloudflare.com', credential: 'CLOUDFLARE_AUTH_TOKEN' });
    assert.match(output.decision.id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(output), /DO-NOT-ECHO|synthetic-workers-bearer-token/);
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
    DECISION_CUSTOM_ACCESS_ID_REF: 'DECISION_CUSTOM_CREDENTIAL_ACCESS_ID',
    DECISION_CUSTOM_ACCESS_SECRET_REF: 'DECISION_CUSTOM_CREDENTIAL_ACCESS_SECRET',
    DECISION_CUSTOM_CREDENTIAL_ACCESS_ID: 'synthetic-access-id',
    DECISION_CUSTOM_CREDENTIAL_ACCESS_SECRET: 'synthetic-access-secret',
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
    { DECISION_CUSTOM_ENDPOINT: 'https://[fd20:ce::254]/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://[::ffff:a9fe:a9fe]/path' },
    { DECISION_CUSTOM_ENDPOINT: 'https://1.2.3.4/route?' },
    { DECISION_CUSTOM_ENDPOINT: 'https://1.2.3.4/route%2Finner' },
    { DECISION_CUSTOM_ENDPOINT: 'https://1.2.3.4/route%252Finner' },
    { DECISION_CUSTOM_ENDPOINT: 'https://décision.example.test/route' },
    { DECISION_CUSTOM_ENDPOINT: 'http://localhost:11434/v1/systemone' },
    { DECISION_CUSTOM_BEARER_REF: 'AWS_SECRET_ACCESS_KEY' },
    { DECISION_CUSTOM_BEARER_REF: 'GITHUB_TOKEN' },
    { DECISION_CUSTOM_ACCESS_ID_REF: 'DECISION_CUSTOM_CREDENTIAL_ACCESS_ID' },
    { DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_A',
      DECISION_CUSTOM_API_KEY_REF: 'DECISION_CUSTOM_CREDENTIAL_B' },
    { DECISION_CUSTOM_ENDPOINT: 'https://user:password@1.2.3.4/route' },
    { DECISION_CUSTOM_ENDPOINT: 'http://192.168.10.11/clef' },
    { DECISION_CUSTOM_BASE_URL: 'https://two.example.test' },
    { DECISION_CUSTOM_PROTOCOL: 'toString' },
    { DECISION_CUSTOM_HEADERS: '[["Authorization","OPENAI_API_KEY"]]', OPENAI_API_KEY: 'synthetic' },
    { DECISION_CUSTOM_HEADERS: '[["x-request-id","DECISION_CUSTOM_HEADER_ID"],["X-Request-Id","DECISION_CUSTOM_HEADER_ID"]]' },
    ...['Host', 'Connection', 'X-Forwarded-Host', 'X-Original-URL', 'Transfer-Encoding', 'Proxy-Authorization']
      .map(name => ({ DECISION_CUSTOM_HEADERS: JSON.stringify([[name, 'CUSTOM_AUTH']]), CUSTOM_AUTH: 'synthetic' })),
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
    ['openai', '/v1/decisions', 'synthetic', { model: 'synthetic', usage: result.usage, answers: [{ name: 'q0', type: 'predicate', probability: 0.7 }] }],
    ['gemini', '/v1beta/decisions', 'synthetic', { answers: { q0: answer } }],
    ['cloudflare', '/ai/run/@cf/cloudflare/clef', 'clef',
      { success: true, result: { ...result, model: 'clef', answers: { q0: answer } } }],
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
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      if (protocol === 'openai') {
        assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_json', data: state }] }]);
        assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
      }
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

test('direct transport handles the named Ollama wire posture and refuses a redirect in a loopback fixture', async t => {
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
  const send = path => {
    const endpoint = `http://127.0.0.1:${server.address().port}/${path}`;
    return pinnedFetch({ endpoint, headers: {} }, directFetch, () => {})(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(2000), body: JSON.stringify({ state }),
    });
  };
  assert.deepEqual(await (await send('safe')).json(), result);
  await assert.rejects(send('redirect'), /redirect refused/);
  assert.equal(calls, 2);
});

test('custom credential binding rejects CLI target switches and token strings in URL or request', async () => {
  const env = {
    ...customEnv, DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_AUTH',
    DECISION_CUSTOM_CREDENTIAL_AUTH: 'synthetic-opaque-endpoint-key',
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
  const injected = createClient({ ...options, env: {
    ...env, DECISION_CUSTOM_CREDENTIAL_AUTH: 'bad\r\nInjected: yes',
  } });
  await assert.rejects(injected.ask(state, questions), { reason: 'invalid_provider_config' });
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

test('custom auth uses the canonical exact path and resolves names only at send time', async () => {
  const env = {
    ...customEnv, DECISION_CUSTOM_ENDPOINT: 'https://DECISION.example.test./internal/%65valuate',
    DECISION_CUSTOM_AUTH_ENDPOINT: 'https://decision.example.test/internal/evaluate',
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_AUTH',
    DECISION_CUSTOM_CREDENTIAL_AUTH: 'before-prepare',
    DECISION_CUSTOM_HEADERS: '[["x-decision-client","DECISION_CUSTOM_HEADER_CLIENT"]]',
    DECISION_CUSTOM_HEADER_CLIENT: 'fixture-client',
  };
  let attempts = 0;
  const trace = [];
  const client = createClient({ provider: 'custom', env,
    onAttempt: data => trace.push(data),
    fetchImpl: (url, options) => {
      attempts++;
      assert.equal(url, 'https://decision.example.test/internal/evaluate');
      assert.equal(trace.length, 1);
      assert.equal(options.headers.authorization, 'Bearer after-prepare');
      assert.equal(options.headers['x-decision-client'], 'fixture-client');
      return Response.json(result);
    },
  });
  env.DECISION_CUSTOM_CREDENTIAL_AUTH = 'after-prepare';
  const output = await client.ask(state, questions);
  assert.equal(attempts, 1);
  assert.deepEqual(output.decision.credential, ['DECISION_CUSTOM_CREDENTIAL_AUTH']);
  assert.doesNotMatch(JSON.stringify(trace), /after-prepare|before-prepare|fixture-client|\/internal/);
  const moved = { ...env, DECISION_CUSTOM_ENDPOINT: 'https://decision.example.test/internal/other' };
  assert.throws(() => createClient({ provider: 'custom', env: moved }), { reason: 'invalid_provider_config' });
});


test('custom rejects all loopback HTTP forms for both an exact endpoint and a base', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    for (const field of ['DECISION_CUSTOM_ENDPOINT', 'DECISION_CUSTOM_BASE_URL']) {
      const env = { ...customEnv, DECISION_CUSTOM_ENDPOINT: undefined,
        [field]: `http://${hostname}:11434/v1/systemone` };
      assert.throws(() => createClient({ provider: 'custom', env,
        fetchImpl: () => assert.fail('HTTP custom transport reached'),
      }), { reason: 'invalid_provider_config' });
    }
  }
});

test('custom refuses ambiguous path syntax before composing or binding credentials', () => {
  const origin = 'https://decision.example.test';
  const paths = ['/a/../b', '/a/%2e%2e/b', '/a/%2E%2E/b', '/a/.%2e/b', '/a/%2e./b',
    '/a/./b', '/a/%2e/b', '//a', '/a//b', '/a/%2fb', '/a/%5Cb', '/a/%252eb', '/a/\\b'];
  for (const path of paths) {
    for (const field of ['DECISION_CUSTOM_ENDPOINT', 'DECISION_CUSTOM_BASE_URL']) {
      for (const authenticated of [false, true]) {
        const env = { ...customEnv, DECISION_CUSTOM_ENDPOINT: undefined, [field]: origin + path };
        if (authenticated) {
          const normalized = path.replaceAll('\\', '/');
          const old = normalized.startsWith('//') ? origin + normalized : new URL(origin + normalized).href;
          const target = old.replace(/([^:]\/)\/{1,}/g, '$1').replace(/\/$/, '');
          env.DECISION_CUSTOM_AUTH_ENDPOINT = target + (field.endsWith('BASE_URL') ? '/v1/systemone' : '');
          env.DECISION_CUSTOM_BEARER_REF = 'DECISION_CUSTOM_CREDENTIAL_FIXTURE';
          env.DECISION_CUSTOM_CREDENTIAL_FIXTURE = 'synthetic-auth-binding';
        }
        assert.throws(() => createClient({ provider: 'custom', env,
          fetchImpl: () => assert.fail('Ambiguous custom transport reached'),
        }), { reason: 'invalid_provider_config' }, `${field}: ${path}, authentication ${authenticated}`);
      }
    }
    assert.throws(() => customEndpoint(origin + '/base', path), /Invalid custom provider configuration/);
  }
  const env = {
    ...customEnv, DECISION_CUSTOM_AUTH_ENDPOINT: origin + '/internal/skip/../evaluate',
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_FIXTURE',
    DECISION_CUSTOM_CREDENTIAL_FIXTURE: 'synthetic-auth-binding',
  };
  assert.throws(() => createClient({ provider: 'custom', env }), { reason: 'invalid_provider_config' });
});

test('custom rejects dot segments with raw or encoded path parameters before auth or transport', () => {
  const origin = 'https://decision.example.test';
  const auth = {
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_FIXTURE',
    DECISION_CUSTOM_CREDENTIAL_FIXTURE: 'synthetic-auth-binding',
  };
  const fetchImpl = () => assert.fail('Custom path parameter reached transport');
  for (const segment of ['.;v=1', '..;', '.%3b', '..%3Bv=1', '%2e;v=1', '.%2E%3b', '%2e%2e%3b']) {
    const path = '/a/' + segment + '/evaluate';
    for (const field of ['DECISION_CUSTOM_ENDPOINT', 'DECISION_CUSTOM_BASE_URL']) {
      const env = { ...customEnv, DECISION_CUSTOM_ENDPOINT: undefined, [field]: origin + path };
      const authEndpoint = origin + path + (field.endsWith('BASE_URL') ? '/v1/systemone' : '');
      for (const options of [env, { ...env, ...auth, DECISION_CUSTOM_AUTH_ENDPOINT: authEndpoint }]) {
        assert.throws(() => createClient({ provider: 'custom', env: options, fetchImpl }),
          { reason: 'invalid_provider_config' }, `${field}: ${segment}`);
      }
    }
    assert.throws(() => customEndpoint(origin + '/base', path), /Invalid custom provider configuration/);
    const env = { ...customEnv, ...auth, DECISION_CUSTOM_AUTH_ENDPOINT: origin + path };
    assert.throws(() => createClient({ provider: 'custom', env, fetchImpl }), { reason: 'invalid_provider_config' });
  }
});

test('custom preserves ordinary parameterized paths and their auth binding over loopback HTTPS', async () => {
  const endpoint = 'https://localhost:8443/.well-known/release;v=1/evaluate%3Bstable';
  const env = {
    ...customEnv, DECISION_CUSTOM_ENDPOINT: endpoint, DECISION_CUSTOM_AUTH_ENDPOINT: endpoint,
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_FIXTURE',
    DECISION_CUSTOM_CREDENTIAL_FIXTURE: 'synthetic-auth-binding',
  };
  const client = createClient({
    provider: 'custom', env,
    fetchImpl: (url, init) => {
      assert.equal(url, endpoint);
      assert.equal(init.headers.authorization, 'Bearer synthetic-auth-binding');
      return Response.json(result);
    },
  });
  assert.deepEqual((await client.ask(state, questions)).answers, result.answers);
});

test('generic auth and non-dedicated credential references are refused even with populated env values', () => {
  const synthetic = { AWS_SECRET_ACCESS_KEY: 'synthetic-aws', GITHUB_TOKEN: 'synthetic-github',
    DATABASE_URL: 'synthetic-db', DECISION_CUSTOM_CREDENTIAL_ONLY: 'synthetic-auth',
    DECISION_CUSTOM_HEADER_ONLY: 'synthetic-metadata' };
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DATABASE_URL']) {
    for (const options of [
      { DECISION_CUSTOM_BEARER_REF: name },
      { DECISION_CUSTOM_HEADERS: JSON.stringify([['x-request-id', name]]) },
    ]) {
      assert.throws(() => createClient({ provider: 'custom', env: { ...customEnv, ...synthetic, ...options } }),
        { reason: 'invalid_provider_config' });
    }
  }
  for (const header of ['Authorization', 'X-Api-Key', 'X-Goog-Api-Key', 'CF-Access-Client-Secret',
    'Cookie', 'Host', 'Connection', 'Content-Length', 'TE', 'Trailer', 'Upgrade', 'Forwarded']) {
    const env = { ...customEnv, ...synthetic, DECISION_CUSTOM_HEADERS: JSON.stringify([[header, 'DECISION_CUSTOM_HEADER_ONLY']]) };
    assert.throws(() => createClient({ provider: 'custom', env }), { reason: 'invalid_provider_config' });
  }
});

test('custom cannot reuse the value of a named provider key through a dedicated reference', async () => {
  const key = 'synthetic-same-key-value';
  const client = createClient({ provider: 'custom', env: {
    ...customEnv, OPENAI_API_KEY: key,
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_DUPLICATE',
    DECISION_CUSTOM_CREDENTIAL_DUPLICATE: key,
  }, fetchImpl: () => assert.fail('Named provider credential reached custom transport') });
  await assert.rejects(client.ask(state, questions), { reason: 'invalid_provider_config' });
});

test('custom does not switch protocols when an endpoint returns a different wire contract', async () => {
  let requests = 0;
  const client = createClient({ provider: 'custom', env: { ...customEnv, DECISION_CUSTOM_PROTOCOL: 'openai' },
    fetchImpl: () => { requests++; return Response.json(result); },
  });
  await assert.rejects(client.ask(state, questions), { reason: 'judgments_unavailable' });
  assert.equal(requests, 1);
});
