import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const script = join(project, 'scripts', 'migrate-decision-plugin.py');
const beforeName = 'jev-enhanced-plugin';
const afterName = 'decision-enhanced-plugin';
const beforeId = `${beforeName}@${beforeName}`;
const afterId = `${afterName}@${afterName}`;
const oldOrigin = `https://github.com/JiaWeiXie/${beforeName}.git`;
const newOrigin = `https://github.com/JiaWeiXie/${afterName}.git`;
const sentinel = 'CREDENTIAL-FIXTURE-DO-NOT-COPY';

function write(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'decision-migration-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NPM_CONFIG_USERCONFIG: join(root, 'npm-user.conf'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'npm-global.conf'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  const run = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
  const command = (cmd, args, cwd = root) => {
    const result = run(cmd, args, cwd);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  const migrate = (...args) => run(script, args);
  const actions = (...args) => JSON.parse(command(script, args)).actions;
  return { root, env, command, migrate, actions };
}

function repoFixture(fixture, directory = 'repo') {
  const { root, command } = fixture;
  const repo = join(root, directory);
  mkdirSync(repo);
  const git = (...args) => command('git', args, repo);
  git('init', '-q');
  write(join(repo, 'tracked.txt'), 'old\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  git('remote', 'add', 'origin', oldOrigin);
  git('config', '--local', 'remote.origin.pushurl', 'ssh://example.invalid/unchanged.git');
  git('config', '--local', 'example.fixture', sentinel);
  write(join(repo, 'tracked.txt'), 'staged\n');
  git('add', 'tracked.txt');
  write(join(repo, 'tracked.txt'), 'working\n');
  write(join(repo, 'untracked.txt'), 'untracked\n');
  return { repo, git, config: join(repo, '.git', 'config') };
}

test('migration preserves unrelated fixture settings, verifies Git changes, repeats and rolls back byte-for-byte', t => {
  const fixture = setup(t);
  const { root, actions } = fixture;
  const { repo, git, config } = repoFixture(fixture);
  const home = join(root, 'home');
  const claude = join(home, '.claude', 'settings.json');
  const codex = join(home, '.codex', 'config.toml');
  const omp = join(home, '.omp', 'agent', 'config.yml');
  const privateFile = join(home, '.omp', 'plugins', 'omp-plugins.lock.json');
  const backup = join(root, 'backup.json');
  write(claude, `{\n  "enabledPlugins": {"${beforeId}": false, "unrelated@other": true},\n  "skillOverrides": {"humanizer":"off"},\n  "env": {"PRIVATE":"${sentinel}","SAMPLE":"${beforeId}"}\n}\n`);
  write(codex, `[plugins."${beforeId}"]\nenabled = true\n[unrelated]\nvalue = "${sentinel}"\n[[skills.config]]\nname="s1-humanizer"\nenabled=false\n[[skills.config]]\nname="humanizer"\nenabled=false\n`);
  write(omp, `disabledExtensions:\n  - "skill:s1-humanizer"\n  - skill:humanizer\n  - skill:decision-humanizer-zh-tw\n  - tool:leave-alone\nconfig: "${sentinel}"\n`);
  write(privateFile, `{"key":"${sentinel}"}\n`);
  const paths = [config, claude, codex, omp, privateFile];
  const before = paths.map(path => readFileSync(path, 'utf8'));
  const status = git('status', '--short');
  const head = git('rev-parse', 'HEAD');
  const expected = ['git-origin', 'claude-settings', 'codex-config', 'omp-yaml'];
  const targets = ['--repo', repo, '--home', home];
  assert.deepEqual(actions('--dry-run', ...targets), expected);
  assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), before);
  assert.equal(existsSync(backup), false);
  assert.deepEqual(actions('--apply', ...targets, '--backup', backup), expected);
  assert.equal(lstatSync(backup).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(backup, 'utf8'), new RegExp(sentinel));
  assert.equal(git('config', '--local', '--get', 'remote.origin.url').trim(), newOrigin);
  assert.equal(git('config', '--local', '--get', 'remote.origin.pushurl').trim(), 'ssh://example.invalid/unchanged.git');
  assert.equal(git('status', '--short'), status);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const migrated = JSON.parse(readFileSync(claude, 'utf8'));
  assert.deepEqual(migrated.enabledPlugins, { [afterId]: false, 'unrelated@other': true });
  assert.deepEqual(migrated.skillOverrides, { humanizer: 'off' });
  assert.deepEqual(migrated.env, { PRIVATE: sentinel, SAMPLE: beforeId });
  assert.match(readFileSync(codex, 'utf8'), /name="decision-humanizer"\nenabled=false/);
  assert.match(readFileSync(codex, 'utf8'), /name="humanizer"\nenabled=false/);
  assert.match(readFileSync(omp, 'utf8'), /skill:decision-humanizer"\n  - skill:humanizer\n  - skill:decision-humanizer-zh-tw/);
  assert.equal(readFileSync(privateFile, 'utf8'), before.at(-1));
  const second = join(root, 'unneeded.json');
  assert.deepEqual(actions('--apply', ...targets, '--backup', second), []);
  assert.equal(existsSync(second), false);
  assert.deepEqual(actions('--dry-run', ...targets), []);
  // Simulate one action already reverted by an interrupted apply.
  write(claude, before[1]);
  write(join(repo, 'tracked.txt'), 'new local edit made after migration\n');
  assert.deepEqual(actions('--rollback', backup), ['git-origin', 'codex-config', 'omp-yaml']);
  assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), before);
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'new local edit made after migration\n');
  assert.deepEqual(actions('--rollback', backup), []);
});

test('migration fails before mutation for collisions, backup reuse and Git lock, and preserves a drifted config', t => {
  const fixture = setup(t);
  const { root, actions, migrate } = fixture;
  const { repo, config } = repoFixture(fixture);
  const home = join(root, 'home');
  const codex = join(home, '.codex', 'config.toml');
  const backup = join(root, 'backup.json');
  const pasted = `[[skills.config]]\nname="s1-humanizer"\nenabled=false\n[[skills.config]]\nname="decision-humanizer"\nenabled=true\n`;
  write(codex, pasted);
  const oldConfig = readFileSync(config, 'utf8');
  assert.equal(migrate('--apply', '--repo', repo, '--home', home, '--backup', backup).status, 1);
  assert.equal(existsSync(backup), false);
  assert.equal(readFileSync(config, 'utf8'), oldConfig);
  assert.equal(readFileSync(codex, 'utf8'), pasted);
  write(config + '.lock', '');
  assert.equal(migrate('--apply', '--repo', repo, '--backup', backup).status, 1);
  assert.equal(readFileSync(config, 'utf8'), oldConfig);
  assert.equal(existsSync(config + '.lock'), true);
  rmSync(config + '.lock');
  assert.equal(migrate('--apply', '--repo', repo, '--backup', backup).status, 1);
  const backup2 = join(root, 'backup2.json');
  assert.deepEqual(actions('--apply', '--repo', repo, '--backup', backup2), ['git-origin']);
  const changed = readFileSync(config, 'utf8') + '\n[extra]\n\tfixture = later\n';
  write(config, changed);
  assert.equal(migrate('--rollback', backup2).status, 1);
  assert.equal(readFileSync(config, 'utf8'), changed);
});

test('old npm bin retires after a real offline new package install and is restored by rollback', t => {
  const { root, command, actions } = setup(t);
  const legacy = join(root, 'legacy');
  const prefix = join(root, 'global');
  write(join(legacy, 'package.json'), JSON.stringify({ name: beforeName, version: '0.2.0', bin: { 'jev-pack': './src/cli.mjs' } }));
  write(join(legacy, 'src/cli.mjs'), '#!/usr/bin/env node\nconsole.log("legacy fixture");\n', 0o700);
  for (const cwd of [legacy, project]) {
    const packed = JSON.parse(command('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], cwd));
    command('npm', ['install', '--global', '--offline', '--ignore-scripts', '--prefix', prefix, join(root, packed[0].filename)]);
  }
  const oldBin = join(prefix, 'bin', 'jev-pack');
  const newBin = join(prefix, 'bin', 'decision-pack');
  const oldTarget = readlinkSync(oldBin);
  const newTarget = readlinkSync(newBin);
  assert.match(command(newBin, ['--help']), /^Usage: decision-pack/);
  const backup = join(root, 'npm-backup.json');
  assert.deepEqual(actions('--dry-run', '--npm-prefix', prefix), ['npm-bin']);
  assert.deepEqual(actions('--apply', '--npm-prefix', prefix, '--backup', backup), ['npm-bin']);
  assert.equal(existsSync(oldBin), false);
  assert.equal(readlinkSync(newBin), newTarget);
  assert.match(command(newBin, ['--help']), /^Usage: decision-pack/);
  assert.deepEqual(actions('--dry-run', '--npm-prefix', prefix), []);
  assert.deepEqual(actions('--rollback', backup), ['npm-bin']);
  assert.equal(readlinkSync(oldBin), oldTarget);
  assert.equal(command(oldBin, []).trim(), 'legacy fixture');
});

test('linked worktrees require explicit complete scope and share one verified config change', t => {
  const fixture = setup(t);
  const { root, command, migrate, actions } = fixture;
  const main = repoFixture(fixture);
  const linked = join(root, 'linked workspace');
  main.git('worktree', 'add', '-qb', 'linked-fixture', linked);
  write(join(linked, 'tracked.txt'), 'linked dirty work\n');
  const status = command('git', ['status', '--short'], linked);
  const backup = join(root, 'shared.json');
  assert.equal(migrate('--dry-run', '--repo', linked).status, 1);
  assert.equal(migrate('--dry-run', '--repo', main.repo).status, 1);
  const targets = ['--repo', main.repo, '--repo', linked];
  assert.deepEqual(actions('--dry-run', ...targets), ['git-origin']);
  assert.deepEqual(actions('--apply', ...targets, '--backup', backup), ['git-origin']);
  assert.equal(main.git('config', '--get', 'remote.origin.url').trim(), newOrigin);
  assert.equal(command('git', ['config', '--get', 'remote.origin.url'], linked).trim(), newOrigin);
  assert.equal(command('git', ['status', '--short'], linked), status);
  assert.deepEqual(actions('--rollback', backup), ['git-origin']);
  assert.equal(command('git', ['config', '--get', 'remote.origin.url'], linked).trim(), oldOrigin);
  assert.equal(command('git', ['status', '--short'], linked), status);
});
