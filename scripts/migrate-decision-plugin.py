#!/usr/bin/env python3
"""Migrate exact legacy plugin references locally, with a reversible journal."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import tomllib

sys.dont_write_bytecode = True

from migration_files import (
    MigrationError, atomic_replace, check_directory, digest, fixture_root, identity,
    open_directory, owned_path, read_checked, read_file, user_path, write_journal,
)

OLD = "jev-enhanced-plugin"
NEW = "decision-enhanced-plugin"
OLD_ID = f"{OLD}@{OLD}"
NEW_ID = f"{NEW}@{NEW}"
OLD_ORIGIN = f"https://github.com/JiaWeiXie/{OLD}.git"
NEW_ORIGIN = f"https://github.com/JiaWeiXie/{NEW}.git"
NAMES = (
    "code-review", "code-simplifier", "grilling", "humanizer",
    "humanizer-zh-tw", "i-have-adhd-zh-tw", "migrate-skill",
)
SKILLS = {f"s1-{name}": f"decision-{name}" for name in NAMES}
OMP_EXTENSIONS = {f"skill:{old}": f"skill:{new}" for old, new in SKILLS.items()}
OLD_BIN = "jev-pack"
NEW_BIN = "decision-pack"
OLD_LINK = f"../lib/node_modules/{OLD}/src/cli.mjs"
NEW_LINK = f"../lib/node_modules/{NEW}/src/cli.mjs"


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise MigrationError("Configuration contains duplicate JSON keys.")
    return result


def json_config(text, paths):
    """Find exact string keys/values at selected JSON paths, preserving all other bytes."""
    decoder = json.JSONDecoder(object_pairs_hook=unique_object)
    decoder.decode(text)
    tokens = iter(re.finditer(r'"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,"]+', text))
    edits = []

    def walk(token, path):
        if token.group() == "{":
            key = next(tokens)
            while key.group() != "}":
                name = json.loads(key.group())
                child = path + (name,)
                replacement = paths.get((child, "key"))
                if replacement is not None:
                    edits.append((key.start(), key.end(), json.dumps(replacement)))
                next(tokens)  # colon
                walk(next(tokens), child)
                separator = next(tokens)
                if separator.group() == "}":
                    break
                key = next(tokens)
        elif token.group() == "[":
            child = next(tokens)
            while child.group() != "]":
                walk(child, path + ("*",))
                if next(tokens).group() == "]":
                    break
                child = next(tokens)
        elif token.group().startswith('"'):
            name = json.loads(token.group())
            replacement = paths.get((path + (name,), "value"))
            if replacement is not None:
                edits.append((token.start(), token.end(), json.dumps(replacement)))

    walk(next(tokens), ())
    updated = replace_spans(text, edits)
    decoder.decode(updated)  # Includes collision detection.
    return updated, edits


def replace_spans(text, edits):
    for start, stop, value in reversed(edits):
        text = text[:start] + value + text[stop:]
    return text


def claude_config(text):
    return json_config(text, {
        (("enabledPlugins", OLD_ID), "key"): NEW_ID,
    })


def codex_config(text):
    original = tomllib.loads(text)
    if '"""' in text or "'''" in text:
        if OLD_ID in text or any(name in text for name in SKILLS):
            raise MigrationError("Codex multiline configuration requires manual migration.")
        return text, []
    edits = []
    section = None
    cursor = 0
    old_header = f'[plugins."{OLD_ID}"]'
    for line in text.splitlines(keepends=True):
        header = re.fullmatch(r"\s*(\[.*\])\s*(?:#.*)?", line.rstrip("\r\n"))
        if header:
            section = header[1]
            if section == old_header:
                start = cursor + header.start(1) + section.index(OLD_ID)
                edits.append((start, start + len(OLD_ID), NEW_ID))
        elif section == "[[skills.config]]":
            match = re.fullmatch(r"""\s*name\s*=\s*(["'])([\w-]+)\1\s*(?:#.*)?""", line.rstrip("\r\n"))
            if match and match[2] in SKILLS:
                edits.append((cursor + match.start(2), cursor + match.end(2), SKILLS[match[2]]))
        cursor += len(line)
    updated = replace_spans(text, edits)
    expected = original.copy()
    if OLD_ID in original.get("plugins", {}):
        plugins = original["plugins"].copy()
        if NEW_ID in plugins:
            raise MigrationError("Codex contains both plugin IDs.")
        plugins[NEW_ID] = plugins.pop(OLD_ID)
        expected["plugins"] = plugins
    if isinstance(original.get("skills", {}).get("config"), list):
        tables = []
        names = [item.get("name") for item in original["skills"]["config"]]
        if any(names.count(old) > 1 or (old in names and new in names) for old, new in SKILLS.items()):
            raise MigrationError("Codex contains conflicting skill overrides.")
        for item in original["skills"]["config"]:
            item = item.copy()
            if isinstance(item.get("path"), str) and Path(item["path"]).parent.name in SKILLS:
                raise MigrationError("Codex path-based skill override requires manual migration.")
            if item.get("name") in SKILLS:
                item["name"] = SKILLS[item["name"]]
            tables.append(item)
        expected["skills"] = {**original["skills"], "config": tables}
    if tomllib.loads(updated) != expected:
        raise MigrationError("Codex contains a relevant entry in an unsupported spelling.")
    return updated, edits


def check_extensions(values):
    if any(values.count(old) > 1 or (old in values and new in values)
           for old, new in OMP_EXTENSIONS.items()):
        raise MigrationError("Oh My Pi contains conflicting extension overrides.")


def omp_yaml(text):
    """Handle only the documented top-level, block-style disabledExtensions list."""
    if OLD not in text and not any(name in text for name in OMP_EXTENSIONS):
        return text, []
    edits = []
    values = []
    in_extensions = False
    indent = None
    blocks = 0
    cursor = 0
    for line in text.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        if stripped and not stripped[0].isspace() and not stripped.startswith(("#", "-")):
            in_extensions = bool(re.fullmatch(r"disabledExtensions:\s*(?:#.*)?", stripped))
            blocks += in_extensions
        if in_extensions and stripped.strip() and not stripped.lstrip().startswith("#") and ":" in stripped:
            match = re.fullmatch(r"""( *)- +(["']?)([\w.:@/+~-]+)\2 *(?:#.*)?""", stripped)
            if match:
                if indent is None:
                    indent = len(match[1])
                if len(match[1]) != indent:
                    raise MigrationError("Oh My Pi extension list uses unsupported indentation.")
                values.append(match[3])
                if match[3] in OMP_EXTENSIONS:
                    edits.append((cursor + match.start(3), cursor + match.end(3), OMP_EXTENSIONS[match[3]]))
            elif not stripped.startswith("disabledExtensions:"):
                raise MigrationError("Oh My Pi extension list requires manual migration.")
        cursor += len(line)
    if blocks > 1:
        raise MigrationError("Oh My Pi contains multiple extension lists.")
    check_extensions(values)
    residue = replace_spans(text, edits)
    if any(re.search(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", residue) for name in OMP_EXTENSIONS) or OLD in residue:
        raise MigrationError("Oh My Pi legacy paths or inline overrides require manual migration.")
    return residue, edits


def omp_json(text):
    values = json.loads(text, object_pairs_hook=unique_object).get("disabledExtensions", [])
    if not isinstance(values, list):
        raise MigrationError("Oh My Pi extension overrides must be a list.")
    check_extensions(values)
    return json_config(text, {
        (("disabledExtensions", "*", key), "value"): value for key, value in OMP_EXTENSIONS.items()
    })


def git(repo, *args, allowed=(0,)):
    path = os.pathsep.join(entry for entry in os.get_exec_path() if os.path.isabs(entry))
    with tempfile.TemporaryDirectory(prefix="decision-git-home-", dir=Path("/tmp").resolve()) as home:
        env = {
            "PATH": path, "LC_ALL": "C", "HOME": home, "XDG_CONFIG_HOME": home,
            "XDG_DATA_HOME": home, "XDG_CACHE_HOME": home, "XDG_STATE_HOME": home,
            "GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_NO_LAZY_FETCH": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "",
        }
        result = subprocess.run(
            ["git", "-C", str(repo), "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", *args],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, timeout=30,
        )
    if result.returncode not in allowed:
        raise MigrationError("A scoped Git check failed.")
    return result.stdout


def local_config(repo, path, *options, allowed=(0,)):
    return git(repo, "config", "--file", str(path), "--no-includes", *options, allowed=allowed)


def repo_state(repo, path):
    keys = local_config(repo, path, "--name-only", "--get-regexp", r"^(include[.]|includeif[.]|filter[.])", allowed=(0, 1))
    if keys:
        raise MigrationError("Git configuration has includes or filters requiring manual migration.")
    git_dir = Path(os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-dir").rstrip(b"\n")))
    if os.path.lexists(git_dir / "config.worktree"):
        raise MigrationError("Git has a separate worktree configuration requiring manual migration.")
    return {
        "head": git(repo, "rev-parse", "HEAD").decode().strip(),
        "status": digest(git(repo, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all")),
        "unstaged": digest(git(repo, "diff", "--no-ext-diff", "--no-textconv", "--binary", "--ignore-submodules=all")),
        "staged": digest(git(repo, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--ignore-submodules=all")),
    }


def remote_config(text):
    edits = []
    origin = False
    cursor = 0
    for line in text.splitlines(keepends=True):
        header = re.match(r"\s*\[([^]]+)\]", line)
        if header:
            origin = header[1] == 'remote "origin"'
        if origin:
            match = re.fullmatch(r"\s*url\s*=\s*(" + re.escape(OLD_ORIGIN) + r")\s*", line)
            if match:
                edits.append((cursor + match.start(1), cursor + match.end(1), NEW_ORIGIN))
        cursor += len(line)
    if len(edits) != 1:
        raise MigrationError("The Git origin uses an unsupported local config spelling.")
    return replace_spans(text, edits), edits


def file_action(path, kind, transform):
    value, mode, info = read_checked(path)
    text = value.decode("utf-8")
    after, edits = transform(text)
    if not edits:
        return None
    delta = 0
    patches = []
    for start, stop, new in edits:
        old = text[start:stop]
        patches.append([start + delta, old, new])
        delta += len(new) - len(old)
    return {
        "kind": kind, "path": str(path), "before": digest(value),
        "after": digest(after.encode()), "mode": mode, "before_identity": identity(info), "patches": patches,
    }


def common_config(repo):
    owned_path(repo)
    root = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel").rstrip(b"\n")))
    if root != repo:
        raise MigrationError("Supply the root of each Git checkout.")
    common = Path(os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").rstrip(b"\n")))
    fallback = common.parent / ".git"
    if common != fallback or not stat.S_ISDIR(owned_path(common).st_mode):
        raise MigrationError("The common Git directory must be inside its primary checkout.")
    owned_path(common / "config")
    return common / "config"


def grouped_repos(repos):
    groups = {}
    for item in repos:
        repo = item.absolute()
        config = common_config(repo)
        groups.setdefault(config, []).append(repo)
    return groups


def check_worktree_scope(config, repos):
    primary = config.parent.parent
    entries = git(primary, "worktree", "list", "--porcelain", "-z").split(b"\0")
    registered = {Path(os.fsdecode(entry[len(b"worktree "):])) for entry in entries if entry.startswith(b"worktree ")}
    if len(set(repos)) != len(repos) or registered != set(repos):
        raise MigrationError("Supply every worktree sharing a Git config, once each.")
    if any(common_config(repo) != config for repo in repos):
        raise MigrationError("The supplied worktrees do not share the expected Git config.")


def group_state(path, repos):
    check_worktree_scope(path, repos)
    return {str(repo): repo_state(repo, path) for repo in repos}


def repo_action(path, repos):
    check_worktree_scope(path, repos)
    origin = local_config(path.parent.parent, path, "--get-all", "remote.origin.url", allowed=(0, 1))
    if origin == (NEW_ORIGIN + "\n").encode():
        return None
    if origin != (OLD_ORIGIN + "\n").encode():
        raise MigrationError("Git origin must be the single exact legacy or canonical HTTPS URL.")
    action = file_action(path, "git-origin", remote_config)
    action["git"] = group_state(path, repos)
    return action


def home_actions(home):
    owned_path(home)
    targets = [
        (".claude/settings.json", "claude-settings", claude_config),
        (".codex/config.toml", "codex-config", codex_config),
    ]
    omp = [name for name in ("config.yml", "config.yaml") if os.path.lexists(home / ".omp" / "agent" / name)]
    if len(omp) > 1:
        raise MigrationError("More than one Oh My Pi YAML config exists.")
    if omp:
        targets.append((f".omp/agent/{omp[0]}", "omp-yaml", omp_yaml))
    else:
        targets.append((".omp/agent/settings.json", "omp-json", omp_json))
    for relative, kind, transform in targets:
        path = home / relative
        if os.path.lexists(path):
            action = file_action(path, kind, transform)
            if action:
                yield action


def npm_action(prefix):
    fixture_root(prefix)
    path = prefix / "bin" / OLD_BIN
    if not os.path.lexists(path):
        return None
    new = path.with_name(NEW_BIN)
    if not stat.S_ISLNK(owned_path(path, allow_link=True).st_mode) or os.readlink(path) != OLD_LINK:
        raise MigrationError("The legacy npm bin is not the expected package symlink.")
    if not stat.S_ISLNK(owned_path(new, allow_link=True).st_mode) or os.readlink(new) != NEW_LINK:
        raise MigrationError("Install and verify the canonical npm bin first.")
    package = prefix / "lib" / "node_modules" / NEW
    manifest, _ = read_file(package / "package.json")
    value = json.loads(manifest)
    if value.get("name") != NEW or value.get("bin", {}).get(NEW_BIN) != "./src/cli.mjs":
        raise MigrationError("The canonical npm package manifest does not match the bin.")
    _, executable_mode = read_file(package / "src" / "cli.mjs")
    if not executable_mode & stat.S_IXUSR:
        raise MigrationError("The canonical npm bin is not executable.")
    return {"kind": "npm-bin", "path": str(path)}



FILE_ACTIONS = {
    "claude-settings": ((".claude", "settings.json"), claude_config),
    "codex-config": ((".codex", "config.toml"), codex_config),
    "omp-yaml": ((".omp", "agent"), omp_yaml),
    "omp-json": ((".omp", "agent", "settings.json"), omp_json),
    "git-origin": ((".git", "config"), remote_config),
}


def file_transform(path, kind):
    if not path.is_absolute() or kind not in FILE_ACTIONS:
        raise MigrationError("Invalid file journal entry.")
    expected, transform = FILE_ACTIONS[kind]
    parts = path.parts
    if kind == "omp-yaml":
        if parts[-3:-1] != expected or path.name not in ("config.yml", "config.yaml"):
            raise MigrationError("Unexpected Oh My Pi journal path.")
    elif parts[-len(expected):] != expected:
        raise MigrationError("Unexpected file journal path.")
    if kind != "git-origin":
        fixture_root(path.parents[len(expected) if kind == "omp-yaml" else len(expected) - 1])
    return transform


def check_legacy_bin(path):
    executable = path.parent.parent / "lib" / "node_modules" / OLD / "src" / "cli.mjs"
    _, mode = read_file(executable)
    if not mode & stat.S_IXUSR:
        raise MigrationError("The rollback npm package is no longer executable.")


def transition(action, reverse, check_only=False):
    path = Path(action["path"])
    if action["kind"] == "npm-bin":
        if not path.is_absolute() or path.name != OLD_BIN or path.parent.name != "bin":
            raise MigrationError("Invalid npm bin journal entry.")
        fixture_root(path.parent.parent)
        with open_directory(path.parent) as parent:
            if reverse:
                if os.path.lexists(path):
                    raise MigrationError("Legacy npm bin path is already occupied.")
                check_legacy_bin(path)
            elif npm_action(path.parent.parent) != action:
                raise MigrationError("The npm bin changed after preflight.")
            check_directory(path.parent, parent)
            if not check_only and reverse:
                os.symlink(OLD_LINK, path.name, dir_fd=parent)
            elif not check_only:
                info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                if (not stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or
                        os.readlink(path.name, dir_fd=parent) != OLD_LINK):
                    raise MigrationError("The npm bin changed before retirement.")
                os.unlink(path.name, dir_fd=parent)
        return
    transform = file_transform(path, action["kind"])
    source, dest = ("after", "before") if reverse else ("before", "after")
    value, mode = read_file(path)
    if digest(value) != action[source] or mode != action["mode"]:
        raise MigrationError("A target no longer matches the expected fingerprint.")
    text = value.decode()
    offset = 0
    edits = []
    for position, old, new in action["patches"]:
        if reverse:
            old, new = new, old
        else:
            position += offset
            offset += len(old) - len(new)
        if text[position:position + len(old)] != old:
            raise MigrationError("A patch no longer matches the expected value.")
        edits.append((position, position + len(old), new))
    changed = replace_spans(text, edits).encode()
    if digest(changed) != action[dest]:
        raise MigrationError("The resulting fingerprint does not match the backup.")
    before_text, after_text = (changed.decode(), text) if reverse else (text, changed.decode())
    if transform(before_text)[0] != after_text:
        raise MigrationError("The backup does not reverse a recognized migration.")
    if action["kind"] == "git-origin":
        check_worktree_scope(path, [Path(repo) for repo in action["git"]])
    if not check_only:
        expected_identity = action.get("before_identity") if not reverse else None
        atomic_replace(path, changed, mode, action[source], expected_identity, action["kind"] == "git-origin")


def verify(action, reverse):
    path = Path(action["path"])
    if action["kind"] == "npm-bin":
        if reverse:
            if not path.is_symlink() or os.readlink(path) != OLD_LINK:
                raise MigrationError("The legacy npm bin was not restored.")
        elif os.path.lexists(path) or os.readlink(path.with_name(NEW_BIN)) != NEW_LINK:
            raise MigrationError("The npm bin readback did not match.")
        return
    value, _ = read_file(path)
    if digest(value) != action["before" if reverse else "after"]:
        raise MigrationError("The changed file did not pass readback.")
    if action["kind"] == "git-origin":
        repo = path.parent.parent
        expected = (OLD_ORIGIN if reverse else NEW_ORIGIN) + "\n"
        if (local_config(repo, path, "--get-all", "remote.origin.url") != expected.encode()
                or group_state(path, [Path(item) for item in action["git"]]) != action["git"]):
            raise MigrationError("Git origin, HEAD, index or working tree readback did not match.")


def pending_rollback(actions):
    seen = set()
    for action in actions:
        path = Path(action["path"])
        if path in seen:
            raise MigrationError("The backup repeats a target.")
        seen.add(path)
        if action["kind"] == "npm-bin":
            if not path.is_absolute() or path.name != OLD_BIN or path.parent.name != "bin":
                raise MigrationError("Invalid npm bin journal entry.")
            if os.path.lexists(path):
                if not path.is_symlink() or os.readlink(path) != OLD_LINK:
                    raise MigrationError("Legacy npm bin path changed since migration.")
                continue
        else:
            file_transform(path, action["kind"])
            value, mode = read_file(path)
            if mode != action["mode"]:
                raise MigrationError("A file mode changed since migration.")
            if digest(value) == action["before"]:
                continue
            if digest(value) != action["after"]:
                raise MigrationError("A target changed since migration. Preserve the backup.")
            if action["kind"] == "git-origin":
                action["git"] = group_state(path, [Path(repo) for repo in action["git"]])
        yield action


def run_actions(actions, reverse):
    order = list(reversed(actions)) if reverse else actions
    for action in order:
        transition(action, reverse, check_only=True)
    done = []
    try:
        for action in order:
            transition(action, reverse)
            done.append(action)
            verify(action, reverse)
    except (MigrationError, OSError, subprocess.SubprocessError):
        recovery_errors = False
        for action in reversed(done):
            try:
                if reverse and action["kind"] != "npm-bin":
                    _, _, opened = read_checked(Path(action["path"]))
                    action["before_identity"] = identity(opened)
                transition(action, not reverse)
                verify(action, not reverse)
            except (MigrationError, OSError, subprocess.SubprocessError):
                recovery_errors = True
        if recovery_errors:
            raise MigrationError("Recovery could not complete. Preserve the backup for manual recovery.")
        raise MigrationError("Migration stopped and completed changes were reversed.")


def write_backup(path, actions):
    value = json.dumps({"version": 1, "actions": actions}, indent=2) + "\n"
    write_journal(path, value.encode())


class MigrationParser(argparse.ArgumentParser):
    def error(self, _message):
        raise MigrationError("Invalid migration argument. Use --help for usage.")


def main():
    parser = MigrationParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="preview (default)")
    mode.add_argument("--apply", action="store_true", help="write an exclusive backup, then apply")
    mode.add_argument("--rollback", type=Path, metavar="BACKUP", help="restore a migration backup")
    parser.add_argument("--backup", type=Path, help="new owner-only backup path for --apply")
    parser.add_argument("--repo", action="append", type=Path, default=[], help="explicit Git checkout")
    parser.add_argument("--home", type=Path, help="explicit temporary home for host preference fixtures")
    parser.add_argument("--npm-prefix", type=Path, help="explicit temporary npm prefix fixture")
    args = parser.parse_args()
    targets = args.repo or args.home or args.npm_prefix
    if (args.rollback and (targets or args.backup)) or (not args.rollback and not targets):
        raise MigrationError("Specify explicit targets, or rollback a backup by itself.")
    if args.apply != bool(args.backup):
        raise MigrationError("--apply requires a new --backup path.")
    if args.rollback:
        value, backup_mode = read_file(user_path(args.rollback.absolute()))
        journal = json.loads(value)
        if backup_mode != 0o600 or journal.get("version") != 1 or not isinstance(journal.get("actions"), list):
            raise MigrationError("Invalid or non-private migration backup.")
        actions = list(pending_rollback(journal["actions"]))
        run_actions(actions, reverse=True)
        print(json.dumps({"mode": "rolled-back", "actions": [action["kind"] for action in actions]}))
        return
    repo_roots = [user_path(repo.absolute()) for repo in args.repo]
    actions = [repo_action(path, repos) for path, repos in grouped_repos(repo_roots).items()]
    if args.home:
        actions.extend(home_actions(fixture_root(user_path(args.home.absolute()))))
    if args.npm_prefix:
        actions.append(npm_action(fixture_root(user_path(args.npm_prefix.absolute()))))
    actions = [action for action in actions if action is not None]
    if len({action["path"] for action in actions}) != len(actions):
        raise MigrationError("A target was supplied more than once.")
    if args.apply and actions:
        backup = user_path(args.backup.absolute())
        if any(backup.is_relative_to(repo) for repo in repo_roots):
            raise MigrationError("The backup must be outside all target Git checkouts.")
        write_backup(backup, actions)
        run_actions(actions, reverse=False)
    mode_name = "applied" if args.apply else "dry-run"
    print(json.dumps({"mode": mode_name, "actions": [action["kind"] for action in actions],
                      "targets": [action["path"] for action in actions]}))


if __name__ == "__main__":
    try:
        main()
    except MigrationError as error:
        print(f"Migration stopped. {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        print("Migration stopped. A target or backup is inaccessible or invalid.", file=sys.stderr)
        sys.exit(1)
