"""Narrow descriptor-relative filesystem operations for the local migrator."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import secrets
import stat

LIMIT = 4 * 1024 * 1024


class MigrationError(Exception):
    """A fixed diagnostic safe to print without configuration contents."""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def identity(info):
    return [info.st_dev, info.st_ino]


@contextmanager
def open_directory(path):
    if not path.is_absolute() or ".." in path.parts:
        raise MigrationError("Migration paths must be absolute and canonical.")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(path.anchor, flags)
    try:
        for segment in path.parts[1:]:
            child = os.open(segment, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def check_directory(path, descriptor):
    with open_directory(path) as current:
        if not os.path.samestat(os.fstat(current), os.fstat(descriptor)):
            raise MigrationError("A target directory changed after opening.")


def owned_path(path, allow_link=False):
    with open_directory(path.parent) as parent:
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        check_directory(path.parent, parent)
    if info.st_uid != os.getuid() or (stat.S_ISLNK(info.st_mode) and not allow_link):
        raise MigrationError("A target is a symbolic link or is owned by another account.")
    return info


def read_at(parent, name):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(name, flags, dir_fd=parent), "rb") as stream:
        info = os.fstat(stream.fileno())
        if (info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or
                info.st_nlink != 1 or info.st_size > LIMIT):
            raise MigrationError("A target is not an owned, singly linked regular file within the size limit.")
        value = stream.read(LIMIT + 1)
        after = os.fstat(stream.fileno())
    lookup = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (len(value) != info.st_size or not os.path.samestat(lookup, info) or lookup.st_nlink != 1 or
            after.st_mtime_ns != info.st_mtime_ns or after.st_ctime_ns != info.st_ctime_ns):
        raise MigrationError("A target changed while it was being read.")
    return value, stat.S_IMODE(info.st_mode), info


def read_checked(path):
    with open_directory(path.parent) as parent:
        result = read_at(parent, path.name)
        check_directory(path.parent, parent)
        return result


def read_file(path):
    value, mode, _ = read_checked(path)
    return value, mode


def atomic_replace(path, value, mode, expected, expected_identity=None, lock_git=False):
    with open_directory(path.parent) as parent:
        name = "config.lock" if lock_git else ".decision-migrate-" + secrets.token_hex(16)
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        temp_stat = os.fstat(descriptor)
        pending = True
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(value)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
                temp_stat = os.fstat(stream.fileno())
            current, current_mode, opened = read_at(parent, path.name)
            if (digest(current) != expected or current_mode != mode or
                    (expected_identity is not None and identity(opened) != expected_identity)):
                raise MigrationError("A target changed after preflight.")
            check_directory(path.parent, parent)
            target = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            temp = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (not os.path.samestat(opened, target) or target.st_ctime_ns != opened.st_ctime_ns or
                    not os.path.samestat(temp_stat, temp) or temp.st_ctime_ns != temp_stat.st_ctime_ns):
                raise MigrationError("A target or staging file changed before replacement.")
            os.replace(name, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            pending = False
        finally:
            if pending:
                try:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if os.path.samestat(temp_stat, current):
                        os.unlink(name, dir_fd=parent)
                except FileNotFoundError:
                    pass


def write_journal(path, content):
    with open_directory(path.parent) as parent:
        check_directory(path.parent, parent)
        descriptor = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(descriptor, "wb") as backup:
            backup.write(content)
            backup.flush()
            os.fsync(backup.fileno())
            stored = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if not os.path.samestat(stored, os.fstat(backup.fileno())) or stored.st_nlink != 1:
                raise MigrationError("The protected backup changed while it was being written.")
        check_directory(path.parent, parent)
        os.fsync(parent)


def fixture_root(path):
    path = path.absolute()
    roots = (Path("/tmp").resolve(), Path("/var/tmp").resolve())
    if not any(path != root and path.is_relative_to(root) for root in roots):
        raise MigrationError("Host preferences and npm bins require an explicit temporary fixture root.")
    if not stat.S_ISDIR(owned_path(path).st_mode):
        raise MigrationError("The fixture root is not a directory.")
    return path


def user_path(path):
    """Accept a platform's /tmp alias only after resolving the fixed OS root."""
    if path.is_relative_to(Path("/tmp")):
        return Path("/tmp").resolve() / path.relative_to("/tmp")
    return path
