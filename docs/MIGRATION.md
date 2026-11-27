# Migrate to Decision Enhanced Plugin

The package and repository changed from `jev-enhanced-plugin` to
`decision-enhanced-plugin`. The CLI is now `decision-pack` and the seven
`s1-<name>` skills are now `decision-<name>`. Pack IDs and job JSON are unchanged.
The TypeSafe variables `TYPESAFE_API_KEY` and `TYPESAFE_MODEL` keep their names.
Leave existing credentials in their current store. See the
[provider configuration](../README.md#providers) to select a different destination.
Existing upstream-skill disable rules remain valid.

## Prepare the new installation

Use the host installation instructions in the [README](../README.md#install).
For an offline install, pass the absolute path to a clean, trusted export of
the candidate to the host's marketplace-add command. Install
`decision-enhanced-plugin@decision-enhanced-plugin`, verify the new skills,
and close or restart the affected sessions before editing preferences.
Keep the legacy install available for rollback.
The migration script edits preferences. The host manages installs and registries.

For an existing npm global install, install the new package to the same explicit
prefix with lifecycle scripts disabled. Verify that the new bin runs first.

```sh
npm install --global --offline --ignore-scripts --prefix /absolute/prefix /absolute/decision-enhanced-plugin.tgz
/absolute/prefix/bin/decision-pack --help
```

## Preview, apply, verify

Run from a trusted checkout with Python 3.11+ and Git. Provide only the roots
you want to migrate. Omit `--home` and `--npm-prefix` for a Git-only change.

```sh
./scripts/migrate-decision-plugin.py --dry-run --repo /absolute/checkout
./scripts/migrate-decision-plugin.py --apply --repo /absolute/checkout --backup /private/existing-dir/decision-migration.json
./scripts/migrate-decision-plugin.py --dry-run --repo /absolute/checkout
```

`--repo` is repeatable. For each checkout, the script changes the single
exact legacy HTTPS `origin` to the canonical HTTPS URL, then verifies the
origin, HEAD, index and working-tree indicators. Git operations are local.
For linked worktrees, supply every checkout sharing the common Git config. The
script changes the shared origin once and verifies each checkout.
A different URL, symlink, or ambiguous config needs manual review. The backup
must be outside the target checkouts.

`--home /absolute/home` looks only at these preference files in the given home.

| Host | Managed preference | Preserved |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` exact plugin key in `enabledPlugins` | Other settings and upstream `skillOverrides` |
| Codex | `.codex/config.toml` exact plugin table and name-based `skills.config` entries | Other tables, values and upstream skill overrides |
| Oh My Pi | `.omp/agent/config.yml` or `config.yaml` block list, or legacy JSON `disabledExtensions` | Other config values and upstream skill disables |

If you have project or alternate home settings, a Codex path-based skill
override or a custom Oh My Pi skill directory, follow the host's documented
configuration and update only the references you can verify against the
new installation. Keep upstream overrides and unrelated config unchanged.
The script does not edit shell profiles, credential stores, host registries,
installed trees or Oh My Pi's credential-bearing lockfile. It does not call
the host plugin managers.

`--npm-prefix /absolute/prefix` retires the exact legacy bin symlink after
checking the replacement package and executable. The legacy package remains
in the prefix for rollback. The script refuses ambiguous existing names and
does not overwrite a custom bin target.

Read the first dry-run action list before applying. The final dry run should
report an empty action list. The script never prints config content,
credential values, or a Git diff.

## Rollback

```sh
./scripts/migrate-decision-plugin.py --rollback /private/existing-dir/decision-migration.json
```

The owner-only backup contains targeted replacements and fingerprints.
Rollback restores only matching migrated entries and skips already restored
ones. If a target has drifted since migration, keep the journal and reconcile
the affected setting manually. After restoring preferences, switch back to
the legacy host installation if necessary.

The automated coverage uses temporary home preference fixtures, disposable Git
repositories and a real local npm prefix. Native host client installations and
real provider inference were not exercised in this change.

## Source and license notes

The original project MIT copyright in `LICENSE`, component notices in
`NOTICE`, and upstream license texts are retained. The source name
`devagrawal09/jev-review` is an upstream MIT attribution. The TypeSafe vendored
SDK remains byte-identical; its version and source digest are recorded in
`audit.json`. The provider adapters use published REST contracts and add no
provider SDK or model weights to the package.
