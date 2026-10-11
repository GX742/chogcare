"""Local Owncast 0.3.0 recovery. Secrets arrive only on stdin, never in this file.

The official CLI necessarily exposes the password in the short-lived Linux
child's argv. We stop that child immediately after its password-saved marker,
then start the normal service without the flag. No database values are edited
by this helper and no protected admin response body is read.
"""

import base64
from contextlib import closing
import json
import os
from pathlib import Path
import pwd
import selectors
import signal
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


ROOT = Path("/opt/owncast")
DATA = ROOT / "data"
DATABASE = DATA / "owncast.db"
BINARY = ROOT / "owncast"
BACKUPS = Path("/var/backups/chogcare-owncast")
UNIT = "owncast.service"
VERSION = "Owncast v0.3.0-linux-64bit (4b09a1b11693977400fb6f6cb06a7b9891bdca6d)"
ORIGIN = "http://127.0.0.1:8080"
PHASES = frozenset(("INPUT", "PREFLIGHT", "BACKUP", "STOP", "SPAWN", "SAVE", "CLEANUP", "RESTART", "VERIFY", "INTERNAL"))
_failure_phase = "INPUT"


class RecoveryError(Exception):
    """Only fixed, non-secret messages may cross the process boundary."""

    def __init__(self, message, *, phase=None):
        super().__init__(message)
        value = _failure_phase if phase is None else phase
        self.phase = value if value in PHASES else "INTERNAL"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def local_status(route, password=None, public_config=False):
    if route not in ("/api/config", "/api/admin/serverconfig"):
        raise RecoveryError("Unsupported local endpoint.")
    headers = {"X-Owncast-CSRF-Protection": "1"}
    if password is not None:
        token = base64.b64encode(("admin:" + password).encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + token
    request = urllib.request.Request(ORIGIN + route, headers=headers, method="GET")
    # No cookies, environment proxy or redirects, including redirects on localhost.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=2) as response:
            if public_config:
                data = json.loads(response.read(65537))
                return response.status, data.get("version")
            # This response contains secrets: deliberately do not read its body.
            return response.status, None
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, None


def systemctl(*arguments, timeout=30):
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", *arguments, UNIT],
            capture_output=True, timeout=timeout, check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RecoveryError("Owncast service command did not complete.") from None
    return result.returncode, result.stdout.decode("utf-8", errors="replace").strip()


def property_value(name):
    code, value = systemctl("show", "--value", "--property=" + name, timeout=5)
    if code != 0:
        raise RecoveryError("Cannot inspect the Owncast service.")
    return value


def checked_path(path, *, directory=False, owner=None, mode=None):
    # Reject symlinks in every ancestor, not just the final file.
    if path.resolve(strict=True) != path or any(p.is_symlink() for p in (path, *path.parents)):
        raise RecoveryError("Unexpected Owncast file path; nothing was changed.")
    info = path.stat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(info.st_mode):
        raise RecoveryError("Unexpected Owncast file type; nothing was changed.")
    if owner is not None and info.st_uid != owner:
        raise RecoveryError("Unexpected Owncast file ownership; nothing was changed.")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RecoveryError("Unexpected Owncast file permissions; nothing was changed.")


def preflight():
    global _failure_phase
    _failure_phase = "PREFLIGHT"
    if os.geteuid() != 0:
        raise RecoveryError("Recovery must run as root in the existing Ubuntu WSL.")
    account = pwd.getpwnam("owncast")
    checked_path(ROOT, directory=True, owner=account.pw_uid)
    checked_path(DATA, directory=True, owner=account.pw_uid, mode=0o700)
    checked_path(DATABASE, owner=account.pw_uid, mode=0o600)
    # The live installation uses WAL. Refuse missing/unsafe sidecars rather than
    # let a root-owned backup connection create new ones for the service user.
    for suffix in ("-wal", "-shm"):
        checked_path(Path(str(DATABASE) + suffix), owner=account.pw_uid, mode=0o600)
    checked_path(BINARY, owner=account.pw_uid)
    expected = {
        "FragmentPath": "/etc/systemd/system/owncast.service",
        "WorkingDirectory": str(ROOT), "User": "owncast", "Group": "owncast",
        "DropInPaths": "", "LoadState": "loaded", "ActiveState": "active",
    }
    if any(property_value(name) != value for name, value in expected.items()):
        raise RecoveryError("Owncast service differs from the verified setup; nothing was changed.")
    unit_path = Path(expected["FragmentPath"])
    checked_path(unit_path, owner=0)
    unit_text = unit_path.read_text(encoding="utf-8")
    starts = [line.strip() for line in unit_text.splitlines() if line.strip().startswith("ExecStart=")]
    if starts != ["ExecStart=/opt/owncast/owncast -webserverip 127.0.0.1"]:
        raise RecoveryError("Unexpected Owncast startup command; nothing was changed.")
    status, version = local_status("/api/config", public_config=True)
    if status != 200 or version != VERSION:
        raise RecoveryError("Unsupported Owncast version; nothing was changed.")
    if local_status("/api/admin/serverconfig")[0] != 401:
        raise RecoveryError("Owncast admin authentication check failed; nothing was changed.")
    return account


def validate_password(password):
    # Keep the recovery protocol deliberately ASCII, within bcrypt's byte limit.
    # The stricter local policy avoids weak/default passwords accepted by the CLI.
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
    return (
        isinstance(password, str) and 14 <= len(password) <= 72
        and all(c in allowed for c in password)
        and any(c.islower() for c in password) and any(c.isupper() for c in password)
        and any(c.isdigit() for c in password) and any(c in "!@#$%^&*" for c in password)
    )


def protected_backup():
    global _failure_phase
    _failure_phase = "BACKUP"
    # Local root-only backup, never in the repository/public relay or Windows temp.
    checked_path(BACKUPS.parent, directory=True, owner=0)
    try:
        BACKUPS.mkdir(mode=0o700)
    except FileExistsError:
        pass
    checked_path(BACKUPS, directory=True, owner=0, mode=0o700)
    backup = BACKUPS / ("before-admin-reset-" + uuid.uuid4().hex + ".db")
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    # SQLite's online backup includes committed WAL contents consistently.
    # No table, secret, hash or key value is selected or printed.
    with closing(sqlite3.connect(DATABASE.as_uri() + "?mode=ro", uri=True, timeout=5)) as source:
        with closing(sqlite3.connect(backup.as_uri() + "?mode=rw", uri=True, timeout=5)) as target:
            deadline = time.monotonic() + 15
            def progress(status, remaining, total):
                if time.monotonic() > deadline:
                    raise RecoveryError("Owncast backup timed out; nothing was changed.")
            source.backup(target, pages=128, progress=progress, sleep=0.05)
    checked_path(backup, owner=0, mode=0o600)
    return backup


def start_recovery(password, account):
    global _failure_phase
    _failure_phase = "SPAWN"
    # A list, not a shell string. No stream-key flag, no DB edits, no secret env.
    # This unavoidable local argv exposure lasts only until the saved marker.
    return subprocess.Popen(
        [str(BINARY), "--database", str(DATABASE), "--webserverip", "127.0.0.1",
         "--adminpassword", password],
        cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        user=account.pw_uid, group=account.pw_gid, extra_groups=(), start_new_session=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(ROOT)},
    )


def wait_for_saved(child):
    global _failure_phase
    _failure_phase = "SAVE"
    deadline = time.monotonic() + 30
    tail = b""
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            for key, _ in selector.select(timeout=0.1):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    raise RecoveryError("Recovery ended without confirming the new password.")
                tail = (tail + chunk)[-8192:]
                if b"Admin password changed" in tail:
                    return
            if child.poll() is not None:
                raise RecoveryError("Recovery ended without confirming the new password.")
    raise RecoveryError("Recovery timed out; password save could not be confirmed.")


def terminate_recovery(child):
    global _failure_phase
    _failure_phase = "CLEANUP"
    # Only the process group created by this Popen; no name matching/pkill.
    try:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        raise RecoveryError("Temporary recovery process could not be stopped; normal service was not started on top of it.") from None
    finally:
        if child.stdout is not None:
            child.stdout.close()


def wait_for_normal(password):
    global _failure_phase
    _failure_phase = "VERIFY"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            status, version = local_status("/api/config", public_config=True)
            if status == 200 and version == VERSION:
                if local_status("/api/admin/serverconfig")[0] != 401:
                    raise RecoveryError("Admin protection could not be verified after restart.")
                login_status = local_status("/api/admin/serverconfig", password)[0]
                if login_status == 200:
                    return
                if login_status == 401:
                    raise RecoveryError("Owncast is running, but it rejected the new password. The reset was not verified.")
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
        time.sleep(0.25)
    raise RecoveryError("Owncast was started, but the new password could not be verified. Do not assume the reset succeeded.")


def reset_password(password):
    global _failure_phase
    _failure_phase = "INPUT"
    if not validate_password(password):
        raise RecoveryError("Password must have 14-72 English characters, uppercase, lowercase, number and !@#$%^&*; no spaces.")
    _failure_phase = "PREFLIGHT"
    account = preflight()
    _failure_phase = "BACKUP"
    protected_backup()
    # A final preflight catches changes during the backup before stopping anything.
    _failure_phase = "PREFLIGHT"
    preflight()
    child = None
    stop_attempted = False
    saved = False
    problem = None
    problem_phase = None
    try:
        _failure_phase = "STOP"
        stop_attempted = True
        code, _ = systemctl("stop")
        if code != 0 or property_value("MainPID") != "0" or property_value("ActiveState") not in ("inactive", "failed"):
            raise RecoveryError("Owncast did not stop cleanly; recovery was not started.")
        _failure_phase = "SPAWN"
        child = start_recovery(password, account)
        _failure_phase = "SAVE"
        wait_for_saved(child)
        saved = True
    except Exception as error:
        # Never format the exception: subprocess errors may contain password argv.
        problem = "Password recovery was not confirmed. The password may already have changed; the old backup was not restored."
        problem_phase = error.phase if isinstance(error, RecoveryError) else _failure_phase
    finally:
        if child is not None:
            _failure_phase = "CLEANUP"
            terminate_recovery(child)
        if stop_attempted:
            _failure_phase = "RESTART"
            code, _ = systemctl("start")
            if code != 0 or property_value("ActiveState") != "active":
                raise RecoveryError("Owncast service did not restart. Payments were not touched; inspect the local Owncast service.")
    if problem is not None or not saved:
        raise RecoveryError(problem or "Password recovery was not confirmed.", phase=problem_phase)
    _failure_phase = "VERIFY"
    wait_for_normal(password)


def main():
    global _failure_phase
    _failure_phase = "INPUT"
    try:
        # Graceful terminal cancellation must pass through reset_password's
        # cleanup rather than leave the temporary password-bearing child alive.
        def cancelled(signum, frame):
            raise RecoveryError("Recovery cancelled; normal-service cleanup was attempted.")
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, cancelled)
        if sys.argv[1:] == ["--check"]:
            _failure_phase = "PREFLIGHT"
            preflight()
            print("PREFLIGHT_OK", flush=True)
            return 0
        if sys.argv[1:]:
            raise RecoveryError("Unsupported recovery arguments.")
        # The controller sends only one bounded stdin frame, with no on-disk secret.
        frame = sys.stdin.buffer.readline(4097)
        if len(frame) > 4096 or not frame.endswith(b"\n"):
            raise RecoveryError("Invalid hidden password input; nothing was changed.")
        payload = json.loads(frame)
        frame = None
        if not isinstance(payload, dict) or set(payload) != {"password"}:
            raise RecoveryError("Invalid hidden password input; nothing was changed.")
        password = payload["password"]
        payload = None
        reset_password(password)
        password = None
        print("RESET_VERIFIED", flush=True)
        return 0
    except RecoveryError as error:
        # A single allowlisted machine code; even an accidentally unsafe error
        # message cannot reveal the password through the controller or logs.
        phase = error.phase if error.phase in PHASES else "INTERNAL"
        print("RECOVERY_ERROR:" + phase, file=sys.stderr, flush=True)
        return 1
    except BaseException:
        # No traceback/raw error can reveal credentials or subprocess arguments.
        phase = _failure_phase if _failure_phase in PHASES else "INTERNAL"
        print("RECOVERY_ERROR:" + phase, file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
