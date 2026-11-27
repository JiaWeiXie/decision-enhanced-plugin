import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const noNetwork = 'data:text/javascript,' + encodeURIComponent(
  "import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';" +
  "http.request = https.request = globalThis.fetch = () => { throw new Error('Unexpected transport in CLI test'); };" +
  'syncBuiltinESMExports();',
);
const testEnv = { PATH: process.env.PATH };
function run(pack, input, args = [], extraEnv = {}, cwd) {
  return spawnSync(process.execPath, ['--import', noNetwork, cli, pack, '--state', '-', '--json', ...args], {
    input, encoding: 'utf8', env: { ...testEnv, ...extraEnv }, cwd,
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
    encoding: 'utf8', env: testEnv,
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

test('offline OpenAI preview omits the wire destination and credentials', () => {
  const secret = 'SYNTHETIC-OPENAI-PREVIEW-KEY';
  const state = { draft: 'Projected draft.', request: 'Review it.', banned: ['LOCAL-ONLY-PREVIEW'] };
  const env = { OPENAI_API_KEY: secret };
  const preview = input => run('reply-check', JSON.stringify(input), ['--provider', 'openai', '--dry-run'], env);
  const result = preview(state);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, 'openai');
  assert.deepEqual(output.request.state, { request: 'Review it.', draftOpening: 'Projected draft.', draft: 'Projected draft.' });
  assert.doesNotMatch(result.stdout + result.stderr, /api\.openai\.com|decision_attempt|Authorization|SYNTHETIC-OPENAI-PREVIEW-KEY|LOCAL-ONLY-PREVIEW/);

  const blocked = preview({ ...state, draft: secret });
  assert.equal(blocked.status, 3);
  assert.equal(JSON.parse(blocked.stdout).reason, 'unsafe_payload');
  assert.doesNotMatch(blocked.stdout + blocked.stderr, /decision_attempt|SYNTHETIC-OPENAI-PREVIEW-KEY/);
});

test('a lone Google key cannot dispatch even with explicit Gemini or auto', () => {
  for (const provider of ['gemini', 'auto']) {
    const result = run('humanizer', '{"passages":["Sample"],"locale":"en"}', ['--provider', provider],
      { GOOGLE_API_KEY: 'SYNTHETIC-GOOGLE-ONLY' });
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).reason, 'missing_api_key');
    assert.doesNotMatch(result.stdout + result.stderr, /decision_attempt|SYNTHETIC-GOOGLE-ONLY/);
  }
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

test('custom destination or model flags cannot fall through to the default provider', () => {
  const input = '{"passages":["Sample"],"locale":"en"}';
  for (const flags of [['--custom-endpoint', 'https://fixture.invalid/'], ['--model', 'clef']]) {
    const result = run('humanizer', input, flags);
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).reason, 'invalid_provider_config');
  }
});

test('implicit TypeSafe with only other provider keys reports a missing TypeSafe key', () => {
  const result = run('humanizer', '{"passages":["Sample"],"locale":"en"}', [],
    { OPENAI_API_KEY: 'SYNTHETIC-OPENAI-140', GEMINI_API_KEY: 'SYNTHETIC-GEMINI-140' });
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).reason, 'missing_api_key');
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC-OPENAI-140|SYNTHETIC-GEMINI-140/);
});

test('unavailable output does not echo a secret in a local-only review path', () => {
  const secret = 'SYNTHETIC-LOCAL-ONLY-REVIEW-SECRET';
  const state = {
    standards: 'Use readable names',
    findings: [{ axis: 'standards', claim: 'Rename the public field', evidence: 'Old example',
      candidates: [], file: secret + '/example.txt', line: 1 }],
  };
  const result = run('review-findings', JSON.stringify(state), [], { OPENAI_API_KEY: secret });
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).reason, 'missing_api_key');
  assert.equal(JSON.parse(result.stdout).result, null);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});

test('provider error output contains only safe attempt metadata and no input', () => {
  const secret = 'SYNTHETIC-RUNTIME-DECISION-AUTH';
  const text = 'APPROVED-SAMPLE-INPUT';
  const result = run('humanizer', JSON.stringify({ passages: [text], locale: 'en' }), [], { TYPESAFE_API_KEY: secret });
  assert.equal(result.status, 3);
  const output = JSON.parse(result.stdout);
  const attempt = JSON.parse(result.stderr.split('\n')[0]);
  assert.equal(attempt.event, 'decision_attempt');
  assert.equal(attempt.origin, 'https://api.typesafe.ai');
  assert.equal(attempt.credential, 'TYPESAFE_API_KEY');
  assert.equal(output.decision.id, attempt.id);
  assert.equal(output.answers, null);
  assert.equal(Object.hasOwn(output, 'result'), false);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret + '|' + text));
});

test('the explicit CLI auto flag opts into a lone OpenAI key', () => {
  const result = run('humanizer', '{"passages":["Sample"],"locale":"en"}', ['--provider', 'auto'],
    { OPENAI_API_KEY: 'SYNTHETIC-OPENAI-EXPLICIT' });
  assert.equal(result.status, 3);
  const attempt = JSON.parse(result.stderr.split('\n')[0]);
  assert.equal(attempt.provider, 'openai');
  assert.equal(attempt.origin, 'https://api.openai.com');
  assert.equal(attempt.credential, 'OPENAI_API_KEY');
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC-OPENAI-EXPLICIT/);
});

test('repository files and job state cannot select a provider or supply its credentials', t => {
  const folder = mkdtempSync(join(tmpdir(), 'decision-config-fixture-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const supplied = {
    DECISION_PROVIDER: 'custom', DECISION_CUSTOM_ENDPOINT: 'https://untrusted.example.test/decision',
    DECISION_CUSTOM_PROTOCOL: 'systemone', DECISION_CUSTOM_MODEL: 'untrusted-model',
    TYPESAFE_API_KEY: 'SYNTHETIC-REPO-ONLY-KEY',
  };
  writeFileSync(join(folder, '.env'), Object.entries(supplied).map(([k, v]) => k + '=' + v).join('\n'));
  writeFileSync(join(folder, 'decision.config.json'), JSON.stringify(supplied));
  const state = JSON.stringify({ passages: ['Synthetic sample'], locale: 'en', ...supplied });
  const result = run('humanizer', state, [], {}, folder);
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).reason, 'missing_api_key');
  assert.doesNotMatch(result.stdout + result.stderr, /decision_attempt|SYNTHETIC-REPO-ONLY-KEY|untrusted\.example/);
});
