import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NPM_CONFIG_USERCONFIG: join(root, 'npm-user.conf'),
    NPM_CONFIG_GLOBALCONFIG: join(root, 'npm-global.conf'),
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  const run = (cmd, args, cwd = root, envOverride = {}) => spawnSync(cmd, args, {
    cwd, env: { ...env, ...envOverride }, encoding: 'utf8', timeout: 30_000,
  });
  const command = (cmd, args, cwd = root) => {
    const result = run(cmd, args, cwd);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  const migrate = (...args) => run(script, args);
  const actions = (...args) => JSON.parse(command(script, args)).actions;
  return { root, env, command, migrate, actions, run };
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
  write(claude, `{\n  "enabledPlugins": {"${beforeId}": false, "unrelated@other": true},\n  "skillOverrides": {"humanizer":"off"},\n  "env": {"PRIVATE":"${sentinel}","SAMPLE":"${beforeId}","DECISION_CUSTOM_AUTH_ENDPOINT":"https://fixture.example.test/scope"}\n}\n`);
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
  assert.deepEqual(migrated.env, {
    PRIVATE: sentinel, SAMPLE: beforeId, DECISION_CUSTOM_AUTH_ENDPOINT: 'https://fixture.example.test/scope',
  });
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

test('npm package dry run and temporary bin migration leave the canonical entry point usable', t => {
  const { root, command, actions } = setup(t);
  const prefix = join(root, 'global');
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  const sentinelPath = join(root, 'lifecycle-ran');
  const legacy = join(root, 'legacy');
  write(join(legacy, 'package.json'), JSON.stringify({ name: beforeName, version: '0.2.0',
    scripts: { preinstall: 'node write-marker.mjs', prepare: 'node write-marker.mjs' },
    bin: { 'jev-pack': './src/cli.mjs' } }));
  write(join(legacy, 'write-marker.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinelPath)}, 'ran');`);
  const oldCLI = '#!/usr/bin/env node\nconsole.log("legacy fixture");\n';
  write(join(legacy, 'src', 'cli.mjs'), oldCLI, 0o700);
  for (const cwd of [legacy, project]) {
    const packageMetadata = JSON.parse(command('npm', ['pack', '--dry-run', '--offline', '--ignore-scripts', '--json'], cwd));
    assert.equal(packageMetadata.length, 1);
    assert.equal(packageMetadata[0].files.some(file => file.path === 'src/cli.mjs'), true);
    command('npm', ['install', '--global', '--dry-run', '--offline', '--ignore-scripts', '--prefix', prefix, cwd]);
  }
  assert.equal(existsSync(sentinelPath), false);
  assert.equal(existsSync(join(prefix, 'bin', 'decision-pack')), false);

  const candidatePackage = join(prefix, 'lib', 'node_modules', afterName);
  const candidateURL = new URL('../src/cli.mjs', import.meta.url).href;
  write(join(candidatePackage, 'package.json'), readFileSync(join(project, 'package.json')));
  write(join(candidatePackage, 'src', 'cli.mjs'), `#!/usr/bin/env node\nimport ${JSON.stringify(candidateURL)};\n`, 0o700);
  write(join(prefix, 'lib', 'node_modules', beforeName, 'src', 'cli.mjs'), oldCLI, 0o700);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const oldBin = join(prefix, 'bin', 'jev-pack');
  const newBin = join(prefix, 'bin', 'decision-pack');
  const oldTarget = `../lib/node_modules/${beforeName}/src/cli.mjs`;
  const newTarget = `../lib/node_modules/${afterName}/src/cli.mjs`;
  symlinkSync(oldTarget, oldBin);
  symlinkSync(newTarget, newBin);
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

test('symlinked host paths or Git config targets are refused without outside changes', t => {
  const fixture = setup(t);
  const { root, migrate } = fixture;
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  const unrelated = join(outside, 'settings.json');
  const content = JSON.stringify({ enabledPlugins: { [beforeId]: true }, private: sentinel });
  write(unrelated, content);
  mkdirSync(home);
  symlinkSync(outside, join(home, '.claude'));
  const journal = join(root, 'backup.json');
  const result = migrate('--apply', '--home', home, '--backup', journal);
  assert.equal(result.status, 1);
  assert.equal(existsSync(journal), false);
  assert.equal(readFileSync(unrelated, 'utf8'), content);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(sentinel));

  const { repo, config } = repoFixture(fixture);
  const outsideConfig = join(outside, 'git-config');
  write(outsideConfig, readFileSync(config));
  rmSync(config);
  symlinkSync(outsideConfig, config);
  assert.equal(migrate('--apply', '--repo', repo, '--backup', journal).status, 1);
  assert.match(readFileSync(outsideConfig, 'utf8'), new RegExp(beforeName));
  assert.equal(existsSync(journal), false);
});

test('Git child processes run in clean temporary homes with networking disabled', t => {
  const fixture = setup(t);
  const { root, command, run } = fixture;
  const { repo } = repoFixture(fixture);
  const git = command('sh', ['-c', 'command -v git']).trim();
  const bin = join(root, 'observed-bin');
  const wrapper = join(bin, 'git');
  const trace = join(root, 'git-checked');
  write(wrapper, `#!/bin/sh
set -eu
test -n "$HOME"
test "$HOME" != ${JSON.stringify(root)}
test "$XDG_CONFIG_HOME" = "$HOME"
test "$XDG_DATA_HOME" = "$HOME"
test "$XDG_CACHE_HOME" = "$HOME"
test "$XDG_STATE_HOME" = "$HOME"
test "\${GITHUB_TOKEN+found}" = ""
test "\${OPENAI_API_KEY+found}" = ""
test "\${HTTPS_PROXY+found}" = ""
test "\${SSH_AUTH_SOCK+found}" = ""
test "\${GIT_ALLOW_PROTOCOL-unset}" = ""
test "$GIT_NO_LAZY_FETCH" = "1"
printf 'checked\n' >> ${JSON.stringify(trace)}
exec ${JSON.stringify(git)} "$@"
`, 0o700);
  const result = run(script, ['--repo', repo], root, {
    PATH: bin + ':' + process.env.PATH, GITHUB_TOKEN: sentinel, OPENAI_API_KEY: sentinel,
    HTTPS_PROXY: 'https://fixture.invalid', SSH_AUTH_SOCK: '/synthetic/path',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.targets, [join(repo, '.git', 'config')]);
  assert.match(readFileSync(trace, 'utf8'), /^checked/);
});

test('same-bytes target replacement between preflight and apply is refused', t => {
  const { root, command, migrate } = setup(t);
  assert.equal(migrate('--home', '/').status, 1);
  const home = join(root, 'home');
  const config = join(home, '.claude', 'settings.json');
  const content = JSON.stringify({ enabledPlugins: { [beforeId]: true } });
  write(config, content);
  const probe = `
import importlib.util
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location("migrator", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
target = Path(sys.argv[2])
action = m.file_action(target, "claude-settings", m.claude_config)
replacement = target.with_suffix(".replacement")
replacement.write_bytes(target.read_bytes())
replacement.chmod(0o600)
os.replace(replacement, target)
try:
    m.transition(action, False)
except m.MigrationError as error:
    assert "changed after preflight" in str(error)
else:
    raise AssertionError("target replacement was not rejected")
`;
  command('python3', ['-B', '-c', probe, script, config]);
  assert.equal(readFileSync(config, 'utf8'), content);
});
