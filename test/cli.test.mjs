import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function run(pack, input, args = []) {
  return spawnSync(process.execPath, [cli, pack, '--state', '-', '--json', ...args], {
    input, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' },
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
    encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' },
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

function providerFixture() {
  globalThis.fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    if (JSON.stringify(body).includes('LOCAL-ONLY-FIXTURE')) throw new Error('unexpected state field');
    if (url === 'https://generativelanguage.googleapis.com/v1beta/decisions') {
      if (request.headers['x-goog-api-key'] !== 'fixture-gemini' || request.headers.authorization ||
          body.model !== 'gemini-decision-1') {
        throw new Error('unexpected Gemini request');
      }
      const ids = Object.keys(body.questions);
      if (ids.some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) return new Response(null, { status: 400 });
      const input = JSON.parse(body.input);
      if (Array.isArray(input.questions)) {
        return Response.json({ answers: Object.fromEntries(ids.map((id, index) =>
          [id, { type: 'noul', noul: (index + 1) / 10 }]).reverse()) });
      }
      if (Array.isArray(input.findings)) {
        const id = 'finding_0_evidence_location';
        const criteria = body.questions[id].criteria;
        if (Object.keys(criteria).some(key => key.trim() !== key)) return new Response(null, { status: 400 });
        if (criteria.option_2 !== 'synthetic exact excerpt' || criteria.option_1 !== 'synthetic unrelated excerpt' ||
            !criteria.noMatch || JSON.stringify(body).includes('LOCAL-FILE-NAME')) {
          throw new Error('unexpected Gemini choice request');
        }
        return Response.json({ answers: {
          [id]: { type: 'choice', choice: 'option_2', confidence: 0.8,
            probabilities: { noMatch: 0.05, option_2: 0.8, option_1: 0.15 } },
        } });
      }
      if (input.draft !== 'Done.') throw new Error('unexpected Gemini input');
      return Response.json({ answers: Object.fromEntries(ids.map(id => [id, { type: 'noul', noul: 0.75 }])) });
    }
    if (url === 'http://localhost:11434/api/chat' && !request.headers.authorization) {
      const { questions } = JSON.parse(body.messages[1].content);
      return Response.json({ done: true, message: { content: JSON.stringify(
        Object.fromEntries(Object.keys(questions).map(id => [id, true])),
      ) } });
    }
    throw new Error('unrecognized mocked endpoint');
  };
}

function runWithProvider(args, env = {}, {
  pack = 'reply-check', state = { request: 'Check it.', draft: 'Done.', banned: ['LOCAL-ONLY-FIXTURE'] },
} = {}) {
  const preload = 'data:text/javascript,' + encodeURIComponent(`(${providerFixture.toString()})()`);
  return spawnSync(process.execPath, ['--import', preload, cli, pack, '--state', '-', '--json', ...args], {
    input: JSON.stringify(state),
    encoding: 'utf8',
    env,
  });
}

test('CLI keeps alternate-provider credentials isolated and exposes native judgments by provider', () => {
  const args = ['--provider', 'gemini'];
  const denied = runWithProvider(args, { TYPESAFE_API_KEY: 'fixture-legacy', OPENAI_API_KEY: 'fixture-other' });
  assert.equal(denied.status, 3);
  assert.match(denied.stderr, /GEMINI_API_KEY is not set/);
  assert.doesNotMatch(denied.stderr, /fixture-/);
  assert.equal(JSON.parse(denied.stdout).reason, 'missing_api_key');

  const allowed = runWithProvider(args, { GEMINI_API_KEY: 'fixture-gemini', TYPESAFE_API_KEY: 'fixture-legacy' });
  assert.equal(allowed.status, 0, allowed.stderr);
  const output = JSON.parse(allowed.stdout);
  assert.equal(output.mode, 'live');
  assert.equal(output.provider, 'gemini');
  assert.equal(output.format, 'gemini-decisions');
  assert.ok(Object.keys(output.answers).length > 0);
  assert.match(output.result.note, /^Provider answers/);
  assert.doesNotMatch(allowed.stdout, /fixture-(gemini|legacy)/);
});

test('CLI displays chat suggestions separately from the deterministic pack result', () => {
  const result = runWithProvider([
    '--provider', 'self-hosted', '--api-format', 'ollama-chat', '--base-url', 'http://localhost:11434/api/',
    '--model', 'fixture-model',
  ], { OLLAMA_API_KEY: 'fixture-cloud-key' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'chat-advisory');
  assert.equal(output.answers, null);
  assert.equal(output.result.judgmentsAvailable, false);
  assert.ok(Object.keys(output.suggestions).length > 0);
});

test('CLI previews the chosen protocol body and refuses invalid selections before inference', () => {
  const preview = runWithProvider(['--dry-run', '--provider', 'openai']);
  assert.equal(preview.status, 0, preview.stderr);
  const output = JSON.parse(preview.stdout);
  assert.equal(output.endpoint, 'https://api.openai.com/v1/decisions');
  assert.equal(output.request.questions[0].type, 'predicate');

  for (const args of [
    ['--provider', 'invalid-provider'],
    ['--provider', 'opencode', '--base-url', 'https://fixture.invalid/'],
    ['--provider', 'self-hosted', '--model', 'fixture-model', '--base-url', 'http://localhost:11434'],
  ]) {
    const result = runWithProvider(['--dry-run', ...args]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
});

test('an explicitly empty mock path fails before it can become an alternate live call', () => {
  const result = runWithProvider(['--mock', '', '--provider', 'gemini'], { GEMINI_API_KEY: 'fixture-gemini' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--mock requires a nonempty file path/);
  assert.equal(result.stdout, '');
});

test('Gemini grilling restores valid pack IDs and matches signals to their original questions', () => {
  const ids = ['phase 1', '階段二', 'phase.3', 'x'.repeat(65), 'q1'];
  const options = {
    pack: 'grilling-frontier',
    state: { context: '', questions: ids.map((id, index) => ({ id, text: `Choose option ${index + 1}?` })) },
  };
  const originalKeys = ids.map(id => `question_${id}_needs_user_decision`);
  const baseline = runWithProvider(['--dry-run'], {}, options);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.deepEqual(Object.keys(JSON.parse(baseline.stdout).request.questions), originalKeys);

  const result = runWithProvider(['--provider', 'gemini'], { GEMINI_API_KEY: 'fixture-gemini' }, options);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, 'gemini');
  assert.equal(output.mode, 'live');
  assert.deepEqual(Object.keys(output.answers), originalKeys);
  assert.deepEqual(output.result.ready, ids);
  assert.deepEqual(output.result.questions.map(question => question.signals.needsUserDecision),
    [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(output.result.autoSettled, []);
});

test('Gemini review-findings restores a remapped candidate and the whole probability distribution', () => {
  const selected = { id: ' padded ', file: 'LOCAL-FILE-NAME', line: 17, excerpt: 'synthetic exact excerpt' };
  const options = {
    pack: 'review-findings',
    state: { findings: [{
      axis: 'standards', claim: 'Synthetic finding',
      candidates: [selected, { id: 'option_1', excerpt: 'synthetic unrelated excerpt' }],
    }] },
  };
  const result = runWithProvider(['--provider', 'gemini'], { GEMINI_API_KEY: 'fixture-gemini' }, options);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.provider, 'gemini');
  assert.equal(output.mode, 'live');
  const answer = output.answers.finding_0_evidence_location;
  assert.equal(answer.choice, selected.id);
  assert.deepEqual(answer.probabilities, { noMatch: 0.05, [selected.id]: 0.8, option_1: 0.15 });
  assert.equal(output.result.findings.length, 1);
  assert.deepEqual(output.result.findings[0].evidenceLocation, {
    status: 'selected', selected, selectedId: selected.id, confidence: 0.8,
  });
});
