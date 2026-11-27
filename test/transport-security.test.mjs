import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, noul } from '../src/decision.mjs';
import { MAX_RESPONSE_BYTES, MAX_RESPONSE_DEPTH, pinnedFetch } from '../src/decision-transport.mjs';

const fixtureKey = 'synthetic-decision-key';
const outbound = { tone: 'neutral' };
const questions = { signal: noul('Does the sample match?') };
const yes = { type: 'noul', noul: 0.75 };
const typedResult = { model: 'fixture-model', usage: { input_tokens: 32, output_tokens: 0 }, answers: { signal: yes } };

const providers = [
  ['typesafe', 'TYPESAFE_API_KEY', {}],
  ['openai', 'OPENAI_API_KEY', {}],
  ['gemini', 'GEMINI_API_KEY', {}],
  ['cloudflare', 'CLOUDFLARE_AUTH_TOKEN', { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }],
  ['ollama', 'OPENAI_API_KEY', {}],
  ['custom', 'DECISION_CUSTOM_CREDENTIAL_FIXTURE', {
    DECISION_CUSTOM_BASE_URL: 'https://fixture.example.test/service',
    DECISION_CUSTOM_PROTOCOL: 'systemone', DECISION_CUSTOM_MODEL: 'fixture-model',
    DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_FIXTURE',
  }],
];

test('the final serialized body guard blocks every provider, including the vendored SDK', async () => {
  const crossFieldSecret = '"tone":"neutral"';
  for (const [provider, name, extra] of providers) {
    const env = { ...extra, [name]: crossFieldSecret };
    const client = createClient({ provider, env, fetchImpl: () => assert.fail(`Transport reached for ${provider}`) });
    const preview = await createClient({ mode: 'dry-run', provider, env }).ask(outbound, questions);
    assert.equal(preview.mode, 'dry-run');
    await assert.rejects(client.ask(outbound, questions), { reason: 'unsafe_payload', decision: null });
  }
});

test('fixed target is checked before credential attachment; SDK headers cannot override bindings', async () => {
  const endpoint = 'https://api.typesafe.ai/v1/systemone';
  let attempts = 0;
  const send = pinnedFetch({ endpoint, headers: { Authorization: 'Bearer bound-fixture' } }, (url, options) => {
    attempts++;
    assert.equal(url, endpoint);
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer bound-fixture' });
    return Response.json(typedResult);
  }, () => {});
  const init = { method: 'POST', body: '{}', headers: { Authorization: 'Bearer rejected', Cookie: 'other', Host: 'invalid' } };
  await assert.rejects(send('https://other.example.test/v1/systemone', init), /Invalid provider endpoint/);
  assert.deepEqual(await (await send(endpoint, init)).json(), typedResult);
  assert.equal(attempts, 1);
});

function streamed(chunks) {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (offset < chunks.length) controller.enqueue(chunks[offset++]);
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    wasCancelled: () => cancelled,
  };
}

test('streamed size and nesting limits cancel before the TypeSafe SDK can buffer or parse', async () => {
  const encoder = new TextEncoder();
  const tooLarge = Array.from({ length: 4 }, () => new Uint8Array(MAX_RESPONSE_BYTES / 2).fill(32));
  const tooDeep = [encoder.encode('{"feedback":'), encoder.encode('['.repeat(MAX_RESPONSE_DEPTH + 1)),
    encoder.encode('0' + ']'.repeat(MAX_RESPONSE_DEPTH + 1) + '}'), encoder.encode(' ')];
  for (const chunks of [tooLarge, tooDeep]) {
    const stream = streamed(chunks);
    const client = createClient({ apiKey: fixtureKey, env: {}, fetchImpl: () => stream.response });
    await assert.rejects(client.ask(outbound, questions), { reason: 'judgments_unavailable' });
    assert.equal(stream.wasCancelled(), true);
  }

  const encoded = encoder.encode(JSON.stringify({ ...typedResult, feedback: '"[\\' + '['.repeat(MAX_RESPONSE_DEPTH + 3) }));
  const stream = streamed([...encoded].map(value => Uint8Array.of(value)));
  const client = createClient({ apiKey: fixtureKey, env: {}, fetchImpl: () => stream.response });
  const accepted = await client.ask(outbound, questions);
  assert.deepEqual(accepted.answers, typedResult.answers);
  assert.equal(Object.hasOwn(accepted, 'feedback'), false);
});

test('error response bodies are cancelled and the decision metadata contains no request or credential', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 });
  const client = createClient({ provider: 'openai', apiKey: fixtureKey, env: {}, fetchImpl: () => response });
  await assert.rejects(client.ask(outbound, questions), error => {
    assert.equal(error.reason, 'judgments_unavailable');
    assert.equal(error.status, 500);
    assert.equal(error.decision.provider, 'openai');
    assert.equal(error.decision.origin, 'https://api.openai.com');
    assert.equal(error.decision.credential, 'explicit');
    assert.doesNotMatch(JSON.stringify(error), /neutral|synthetic-decision-key/);
    return true;
  });
  assert.equal(cancelled, true);
});

test('explicit cancellation aborts live response consumption with no second request', async () => {
  const controller = new AbortController();
  let calls = 0;
  let cancelled = false;
  const client = createClient({ provider: 'openai', apiKey: fixtureKey, env: {}, fetchImpl: () => {
    calls++;
    return new Response(new ReadableStream({
      pull() { controller.abort(); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(client.ask(outbound, questions, { signal: controller.signal }), { reason: 'judgments_unavailable' });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('unknown answer fields and oversized feedback fail closed', async () => {
  for (const response of [
    { ...typedResult, injected: 'unknown' },
    { ...typedResult, answers: { signal: { ...yes, script: 'ignored' } } },
    { ...typedResult, feedback: 'a'.repeat(1025) },
    { ...typedResult, feedback: { message: 'bad type' } },
    { ...typedResult, usage: { ...typedResult.usage, input_tokens: -1 } },
  ]) {
    const client = createClient({ apiKey: fixtureKey, env: {}, fetchImpl: () => Response.json(response) });
    await assert.rejects(client.ask(outbound, questions), { reason: 'judgments_unavailable' });
  }
});

test('duplicate JSON answer properties cannot be silently overwritten by JSON.parse', async () => {
  const encoded = JSON.stringify(typedResult).replace('"answers":{', '"answers":{"\\u0073ignal":{"type":"refusal"},');
  const client = createClient({ apiKey: fixtureKey, env: {}, fetchImpl: () => new Response(encoded, {
    headers: { 'Content-Type': 'application/json' },
  }) });
  await assert.rejects(client.ask(outbound, questions), { reason: 'judgments_unavailable' });
});

test('TLS transport ignores inherited proxy and custom-root settings', async t => {
  const root = mkdtempSync(join(tmpdir(), 'decision-tls-fixture-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const key = join(root, 'fixture-key.pem');
  const cert = join(root, 'fixture-cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', key, '-out', cert, '-days', '1'], { stdio: 'ignore', timeout: 5000 });
  assert.equal(generated.status, 0, 'generate a disposable self-signed fixture');
  let proxied = 0;
  let applicationRequests = 0;
  let tlsHandshakes = 0;
  const proxy = createHTTPServer((_req, res) => { proxied++; res.writeHead(500).end(); });
  proxy.on('connect', (_req, socket) => { proxied++; socket.destroy(); });
  const server = createHTTPSServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    applicationRequests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    if (req.method !== 'POST' || req.url !== '/fixture' || req.headers.authorization !== 'Bearer synthetic-local-auth' ||
      request.state?.tone !== 'neutral') {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(typedResult));
  });
  server.on('tlsClientError', () => { tlsHandshakes++; });
  server.listen(0, '127.0.0.1');
  proxy.listen(0, '127.0.0.1');
  t.after(() => { server.close(); proxy.close(); });
  await Promise.all([once(server, 'listening'), once(proxy, 'listening')]);
  const moduleURL = new URL('../src/decision-transport.mjs', import.meta.url).href;
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  const endpoint = `https://127.0.0.1:${server.address().port}/fixture`;
  const source = `import { directFetch } from ${JSON.stringify(moduleURL)};
    try {
      await directFetch(${JSON.stringify(endpoint)}, { method: 'POST', headers: {}, body: '{}', signal: AbortSignal.timeout(2000) });
      process.exitCode = 1;
    } catch (error) {
      if (error.code !== 'DEPTH_ZERO_SELF_SIGNED_CERT') process.exitCode = 2;
    }`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PATH: process.env.PATH, HOME: root, NODE_EXTRA_CA_CERTS: cert, NODE_TLS_REJECT_UNAUTHORIZED: '0',
      HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL, NODE_USE_ENV_PROXY: '1' },
    stdio: 'ignore', timeout: 5000,
  });
  assert.deepEqual(await once(child, 'exit'), [0, null]);
  assert.equal(applicationRequests, 0);
  assert.equal(proxied, 0);
  assert.equal(tlsHandshakes, 1);

  // Trust the throwaway CA only inside this fixture process. Production code offers no CA override.
  const clientURL = new URL('../src/decision.mjs', import.meta.url).href;
  const positiveSource = `import https from 'node:https';
    import { readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const request = https.request;
    https.request = (url, options, callback) => request(url, { ...options, ca: readFileSync(process.env.FIXTURE_CA) }, callback);
    syncBuiltinESMExports();
    const { createClient, noul } = await import(${JSON.stringify(clientURL)});
    const endpoint = ${JSON.stringify(endpoint)};
    const client = createClient({ provider: 'custom', env: {
      DECISION_CUSTOM_ENDPOINT: endpoint, DECISION_CUSTOM_AUTH_ENDPOINT: endpoint,
      DECISION_CUSTOM_PROTOCOL: 'systemone', DECISION_CUSTOM_MODEL: 'fixture-model',
      DECISION_CUSTOM_BEARER_REF: 'DECISION_CUSTOM_CREDENTIAL_FIXTURE',
      DECISION_CUSTOM_CREDENTIAL_FIXTURE: 'synthetic-local-auth',
    } });
    const result = await client.ask({tone: 'neutral'}, {signal: noul('Does the sample match?')});
    if (result.answers.signal.noul !== 0.75) process.exitCode = 3;`;
  const testProcess = spawn(process.execPath, ['--input-type=module', '--eval', positiveSource], {
    env: { PATH: process.env.PATH, HOME: root, FIXTURE_CA: cert,
      HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL, NODE_USE_ENV_PROXY: '1' },
    stdio: 'ignore', timeout: 5000,
  });
  assert.deepEqual(await once(testProcess, 'exit'), [0, null]);
  assert.equal(applicationRequests, 1);
  assert.equal(proxied, 0);
});
