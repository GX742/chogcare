"""Bounded local broadcast recovery. Never restarts the source or payment worker."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import fcntl
except ImportError:  # Pure parser/decision tests also run on Windows CI.
    fcntl = None

SOURCE = "http://127.0.0.1:8082/hls/0/stream.m3u8"
MOBILE = Path("/var/lib/chogcare-mobile/stream.m3u8")
PREVIEW = Path("/var/lib/chogcare-preview/preview.jpg")
STATE_DIRECTORY = Path("/var/lib/chogcare-broadcast-health")
UNITS = {"mobile": "chogcare-mobile.service", "preview": "chogcare-preview.service"}
MAX_PLAYLIST = 65536
MAX_STATE = 16384
STARTUP_GRACE = 90
UPSTREAM_FRESH = 20
STALE_AFTER = {"mobile": 30, "preview": 20}
COOLDOWN = 120
MAX_COOLDOWN = 900
RESET_AFTER = 600
MAX_OBSERVATION_GAP = 300


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def playlist_identity(text, source=False):
    """Accept only the known bounded media formats; retain no segment names."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_PLAYLIST:
        raise ValueError("Invalid playlist")
    lines = text.splitlines()
    if not lines or lines[0] != "#EXTM3U":
        raise ValueError("Invalid playlist")
    sequence = target = None
    pending = False
    segments = []
    filename = (r"stream-[A-Za-z0-9_-]{1,64}-[0-9]{1,15}\.ts" if source
                else r"stream-[0-9]{1,20}\.ts")
    for line in lines[1:]:
        if not line:
            continue
        if re.fullmatch(r"#EXT-X-MEDIA-SEQUENCE:[0-9]{1,20}", line) and sequence is None:
            sequence = int(line.split(":")[1])
        elif re.fullmatch(r"#EXT-X-TARGETDURATION:[0-9]{1,2}", line) and target is None:
            target = int(line.split(":")[1])
        elif re.fullmatch(r"#EXT-X-VERSION:[1-9]", line) or line == "#EXT-X-INDEPENDENT-SEGMENTS":
            continue
        elif re.fullmatch(r"#EXTINF:[0-9]{1,2}(?:\.[0-9]{1,9})?,", line) and not pending:
            duration = float(line.split(":")[1].rstrip(","))
            if not 0 < duration <= (5 if source else 60):
                raise ValueError("Invalid segment duration")
            pending = True
        elif re.fullmatch(r"#EXT-X-PROGRAM-DATE-TIME:[0-9T:+.Z-]{15,40}", line) and pending:
            continue
        elif re.fullmatch(filename, line) and pending:
            segments.append(line)
            pending = False
        else:
            raise ValueError("Unsupported playlist")
    if sequence is None or target is None or not 1 <= target <= (5 if source else 60) or pending or not 1 <= len(segments) <= 128:
        raise ValueError("Incomplete playlist")
    return digest(str(sequence) + ":" + segments[-1])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def source_identity():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(SOURCE, timeout=2) as response:
        if response.status != 200:
            raise ValueError("Source unavailable")
        body = response.read(MAX_PLAYLIST + 1)
    return playlist_identity(body.decode("utf-8"), source=True)


def read_regular(path, limit, private=False):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > limit:
            raise ValueError("Unexpected local file")
        if private and (metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077):
            raise ValueError("Unprotected state")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            body = stream.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Oversized local file")
        return body
    finally:
        os.close(descriptor)


def preview_identity():
    metadata = PREVIEW.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or not 0 < metadata.st_size <= 2 * 1024 * 1024:
        raise ValueError("Invalid preview")
    # A static camera may legitimately write identical JPEG bytes each second.
    return digest(str(metadata.st_mtime_ns) + ":" + str(metadata.st_size))


def service_status(unit):
    if unit not in UNITS.values():
        raise ValueError("Unapproved service")
    result = subprocess.run(["/bin/systemctl", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "ActiveEnterTimestampMonotonic"],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=3, check=True)
    if len(result.stdout) > 4096:
        raise ValueError("Oversized service status")
    fields = dict(line.split("=", 1) for line in result.stdout.decode("utf-8").splitlines() if "=" in line)
    return {"active": fields.get("ActiveState") == "active", "pid": int(fields.get("MainPID", "0")),
            "started_at": int(fields.get("ActiveEnterTimestampMonotonic", "0")) / 1000000}


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def valid_identity(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def fresh_state(now, boot):
    return {"version": 1, "boot": boot, "checked_at": now, "monitor_started_at": now,
            "tracks": {name: {"identity": None, "still_since": now, "progress_at": None} for name in ("source", "mobile", "preview")},
            "units": {name: {"producer": None, "attempts": 0, "next_allowed": 0, "last_attempt": 0, "healthy_since": None} for name in UNITS}}


def validated_state(previous, now, boot):
    try:
        if set(previous) != {"version", "boot", "checked_at", "monitor_started_at", "tracks", "units"} or set(previous["tracks"]) != {"source", "mobile", "preview"} or set(previous["units"]) != set(UNITS):
            raise ValueError()
        if previous["version"] != 1 or previous["boot"] != boot or not number(previous["checked_at"]) or not 0 <= now - previous["checked_at"] <= MAX_OBSERVATION_GAP:
            raise ValueError()
        if not number(previous["monitor_started_at"]) or previous["monitor_started_at"] > now:
            raise ValueError()
        for track in previous["tracks"].values():
            if set(track) != {"identity", "still_since", "progress_at"}:
                raise ValueError()
            if track["identity"] is not None and not valid_identity(track["identity"]):
                raise ValueError()
            if not number(track["still_since"]) or track["still_since"] > now or track["progress_at"] is not None and (not number(track["progress_at"]) or track["progress_at"] > now):
                raise ValueError()
        for name in ("source", "mobile", "preview"):
            previous["tracks"][name]
        for name in UNITS:
            unit = previous["units"][name]
            if set(unit) != {"producer", "attempts", "next_allowed", "last_attempt", "healthy_since"}:
                raise ValueError()
            if unit["producer"] is not None and not valid_identity(unit["producer"]):
                raise ValueError()
            if type(unit["attempts"]) is not int or not 0 <= unit["attempts"] <= 16 or any(not number(unit[key]) for key in ("next_allowed", "last_attempt")):
                raise ValueError()
            if unit["last_attempt"] > now or unit["next_allowed"] > now + MAX_COOLDOWN:
                raise ValueError()
            if unit["healthy_since"] is not None and (not number(unit["healthy_since"]) or unit["healthy_since"] > now):
                raise ValueError()
        return copy.deepcopy(previous)
    except (KeyError, TypeError, ValueError, AttributeError):
        return fresh_state(now, boot)


def evaluate(previous, observation, now, boot):
    """Pure decision engine. Observations and previous state are never mutated."""
    if not number(now) or not isinstance(boot, str) or not boot:
        raise ValueError("Invalid health clock")
    state = validated_state(previous, now, boot)
    actions = []
    services = observation.get("services", {})
    for name in UNITS:
        service = services.get(name, {})
        started = service.get("started_at")
        pid = service.get("pid")
        producer = digest(str(pid) + ":" + str(started)) if type(pid) is int and pid > 0 and number(started) and started <= now else None
        if producer != state["units"][name]["producer"]:
            state["units"][name]["producer"] = producer
            state["units"][name]["healthy_since"] = None
            state["tracks"][name] = {"identity": None, "still_since": now, "progress_at": None}
            if name == "mobile":
                state["tracks"]["preview"] = {"identity": None, "still_since": now, "progress_at": None}
    for name, track in state["tracks"].items():
        identity = observation.get(name)
        if valid_identity(identity) and identity != track["identity"]:
            if track["identity"] is not None:
                track["progress_at"] = now
            track["identity"], track["still_since"] = identity, now
    def advancing(name):
        track = state["tracks"][name]
        return valid_identity(observation.get(name)) and track["progress_at"] is not None and now - track["progress_at"] <= UPSTREAM_FRESH
    def started(name):
        service = services.get(name, {})
        return service.get("active") is True and state["units"][name]["producer"] is not None and now - service["started_at"] >= STARTUP_GRACE
    for name in UNITS:
        unit, track = state["units"][name], state["tracks"][name]
        upstream_ready = advancing("source") and (name == "mobile" or advancing("mobile") and started("mobile"))
        healthy = advancing(name) and upstream_ready and started(name)
        if healthy:
            if unit["healthy_since"] is None or now - state["checked_at"] > UPSTREAM_FRESH:
                unit["healthy_since"] = now
            if unit["attempts"] and now - unit["healthy_since"] >= RESET_AFTER:
                unit.update(attempts=0, next_allowed=0, last_attempt=0)
        else:
            unit["healthy_since"] = None
        stale = now - track["still_since"] >= STALE_AFTER[name]
        if now - state["monitor_started_at"] >= STARTUP_GRACE and started(name) and upstream_ready and stale and now >= unit["next_allowed"]:
            actions.append(UNITS[name])
            unit["attempts"] = min(16, unit["attempts"] + 1)
            unit["last_attempt"] = now
            unit["next_allowed"] = now + min(MAX_COOLDOWN, COOLDOWN * 2 ** (unit["attempts"] - 1))
            unit["healthy_since"] = None
    state["checked_at"] = now
    return state, actions


def atomic_state(path, state):
    data = json.dumps(state, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) > MAX_STATE:
        raise ValueError("Oversized health state")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".health-", dir=path.parent, delete=False) as stream:
            temporary = stream.name
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def restart_unit(unit, run=subprocess.run):
    if unit not in UNITS.values():
        raise ValueError("Unapproved recovery target")
    # A concurrent deliberate stop must not be undone by this health check.
    return run(["/bin/systemctl", "try-restart", "--no-block", unit], stdin=subprocess.DEVNULL,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False).returncode == 0


def main():
    if len(sys.argv) != 1 or sys.platform != "linux" or fcntl is None:
        return 2
    directory = STATE_DIRECTORY.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.geteuid() or directory.st_mode & 0o077:
        raise ValueError("Unprotected health directory")
    descriptor = os.open(STATE_DIRECTORY / "health.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        lock = os.fstat(descriptor)
        if not stat.S_ISREG(lock.st_mode) or lock.st_nlink != 1 or lock.st_uid != os.geteuid() or lock.st_mode & 0o077:
            raise ValueError("Unprotected health lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        state_path = STATE_DIRECTORY / "state.json"
        try:
            previous = json.loads(read_regular(state_path, MAX_STATE, private=True))
        except (FileNotFoundError, ValueError, UnicodeError):
            previous = None
        observation = {"services": {}}
        for name, reader in [("source", source_identity), ("mobile", lambda: playlist_identity(read_regular(MOBILE, MAX_PLAYLIST).decode("utf-8"))), ("preview", preview_identity)]:
            try:
                observation[name] = reader()
            except Exception:
                observation[name] = None
        for name, unit in UNITS.items():
            try:
                observation["services"][name] = service_status(unit)
            except Exception:
                observation["services"][name] = {}
        boot = digest(Path("/proc/sys/kernel/random/boot_id").read_text().strip())
        state, actions = evaluate(previous, observation, time.monotonic(), boot)
        # Persist the cooldown before asking systemd: a failed restart request
        # cannot cause a timer or manual invocation to hammer the same unit.
        atomic_state(state_path, state)
        for unit in actions:
            try:
                accepted = restart_unit(unit)
            except Exception:
                accepted = False
            component = next(name for name, value in UNITS.items() if value == unit)
            print(json.dumps({"event": "recovery-requested" if accepted else "recovery-deferred", "component": component}))
        return 0
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print('{"event":"health-check-unavailable"}')
        sys.exit(1)
