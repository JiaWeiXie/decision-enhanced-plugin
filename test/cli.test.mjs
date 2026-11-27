import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function run(pack, input, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [cli, pack, '--state', '-', '--json', ...args], {
    input, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', DECISION_PROVIDER: 'auto', ...extraEnv },
  });
}
function invoke(input, args = []) {
  return run('humanizer', JSON.stringify(input), args);
}

test('misspelled dry-run does not silently attempt live mode', () => {
  const result = invoke({ passages: ['Private input'] }, ['--dryrun']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('missing required collection is an input error, not a clean empty judgment', () => {
  const result = invoke({ text: 'Wrong shape must not disappear' }, ['--dry-run']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('help advertises live as the default and preview and replay as explicit options', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', DECISION_PROVIDER: 'auto' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Live mode is the default/);
  assert.match(result.stdout, /--dry-run performs no inference/);
  assert.match(result.stdout, /--mock replays/);
});

test('default mode without a key preserves prose and exits unavailable', () => {
  const result = invoke({ passages: ['Keep 420 ms and `retry_count=3`.'], locale: 'en', context: 'Preserve facts.' });
  assert.equal(result.status, 3);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'unavailable');
  assert.equal(output.reason, 'missing_api_key');
  assert.equal(output.answers, null);
  assert.equal(output.result.passages[0].text, 'Keep 420 ms and `retry_count=3`.');
  assert.equal(output.result.rewritten, false);
});

test('malformed JSON fails without echoing the supplied state back to the operator', () => {
  const result = run('humanizer', '{"passages": ["ZQX-PRIVATE-MARKER-7731"],}', ['--dry-run']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('ZQX-PRIVATE-MARKER-7731'));
  assert.match(result.stderr, /State must be valid JSON/);
});

test('pack state validation failure is reported as an input error', () => {
  const result = run('reply-check', JSON.stringify({ draft: 'Sure, sending it over.' }), ['--dry-run']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /request/);
});

test('dry-run shows the filtered model state, not the raw pack state', () => {
  const state = { draft: 'Done.\n\nMore.', request: 'Fix it.', banned: ['ZQX-WATCHED-4410'] };
  const result = run('reply-check', JSON.stringify(state), ['--dry-run']);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.request.state, { request: 'Fix it.', draftOpening: 'Done.', draft: 'Done.\n\nMore.' });
  assert.deepEqual(Object.keys(output.request.state), ['request', 'draftOpening', 'draft'], 'reference before material');
  assert.ok(!result.stdout.includes('ZQX-WATCHED-4410'));
});

test('unknown provider from the flag or environment is unavailable and is not echoed', () => {
  const secret = 'FIXTURE-UNKNOWN-77312';
  const values = [['--provider', secret], []];
  for (const args of values) {
    const env = args.length ? {} : { DECISION_PROVIDER: secret };
    const result = run('humanizer', '{"passages":[]}', args, env);
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).reason, 'unknown_provider');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  }
});

test('explicit provider overrides an invalid environment in offline preview', () => {
  const result = run('humanizer', '{"passages":["Sample"],"locale":"en"}', ['--provider', 'gemini', '--dry-run'],
    { DECISION_PROVIDER: 'invalid' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).provider, 'gemini');
});

test('secret-bearing payload never appears in stdout or stderr even with preview requested', () => {
  const secret = 'SYNTHETICBLOCKEDTOKEN12345';
  for (const args of [['--dry-run'], []]) {
    const result = run('humanizer', JSON.stringify({ passages: [`password="${secret}"`], locale: 'en' }), args,
      { TYPESAFE_API_KEY: 'fixture-key' });
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).reason, 'unsafe_payload');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  }
});

test('custom destination or model flags cannot fall through to auto', () => {
  const input = '{"passages":["Sample"],"locale":"en"}';
  for (const flags of [['--custom-endpoint', 'https://fixture.invalid/'], ['--model', 'clef']]) {
    const result = run('humanizer', input, flags);
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).reason, 'invalid_provider_config');
  }
});
