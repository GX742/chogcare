"""Verify a public code-only archive before root extracts it; never opens state."""
import hashlib
import io
import json
import os
import pathlib
import re
import stat
import sys
import tarfile


def allowed_file(name):
    return name in {"package.json", "package-lock.json", "release-manifest.json", "docs/PAYMENT-SERVER.md", "test/station-remote.test.mjs", "test/station-broadcast-remote.test.mjs", "test/payment-host-retirement.test.mjs", "test/payment-host-readiness.test.mjs"} or bool(
        re.fullmatch(r"scripts/[a-z0-9.-]+\.(?:mjs|ps1)", name)
        or re.fullmatch(r"server/[a-z0-9.-]+\.mjs", name)
        or re.fullmatch(r"src/[a-z0-9.-]+\.ts", name)
        or re.fullmatch(r"ops/payments/(?:test/)?[A-Za-z0-9.-]+\.(?:mjs|service|conf|md|sh|py)", name)
    )


def verify_package(data, expected_sha):
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha):
        raise ValueError("CODE_PACKAGE_DIGEST_REQUIRED")
    if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected_sha:
        raise ValueError("CODE_PACKAGE_DIGEST_MISMATCH")
    files = {}; total = 0; members = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            members += 1
            if members > 8192:
                raise ValueError("CODE_PACKAGE_MEMBER_LIMIT")
            raw = member.name
            if "\\" in raw or ":" in raw or raw.startswith("/") or ".." in pathlib.PurePosixPath(raw).parts:
                raise ValueError("CODE_PACKAGE_PATH_INVALID")
            name = str(pathlib.PurePosixPath(raw))
            if name == "." and member.isdir():
                continue
            if member.isdir():
                if name not in {"scripts", "server", "src", "docs", "test", "ops", "ops/payments", "ops/payments/test"}:
                    raise ValueError("CODE_PACKAGE_DIRECTORY_INVALID")
                continue
            if not member.isfile() or not allowed_file(name) or name in files or member.size > 4 * 1024 * 1024 or len(files) >= 4096:
                raise ValueError("CODE_PACKAGE_MEMBER_INVALID")
            total += member.size
            if total > 64 * 1024 * 1024:
                raise ValueError("CODE_PACKAGE_SIZE_LIMIT")
            files[name] = archive.extractfile(member).read()
    manifest = json.loads(files.get("release-manifest.json", b"null"))
    if not isinstance(manifest, dict) or set(manifest) != {"version", "files"} or manifest["version"] != 1 or not isinstance(manifest["files"], list):
        raise ValueError("CODE_PACKAGE_MANIFEST_INVALID")
    listed = set()
    for item in manifest["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"} or not isinstance(item["path"], str) or not allowed_file(item["path"]) or item["path"] in listed or not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
            raise ValueError("CODE_PACKAGE_MANIFEST_INVALID")
        listed.add(item["path"])
        if item["path"] not in files or hashlib.sha256(files[item["path"]]).hexdigest() != item["sha256"]:
            raise ValueError("CODE_PACKAGE_SOURCE_MISMATCH")
    if listed != set(files) - {"release-manifest.json"} or not {"package.json", "package-lock.json", "scripts/cloud-payments.mjs"}.issubset(listed):
        raise ValueError("CODE_PACKAGE_SOURCE_SET_INVALID")
    return {"verified": True, "codeOnly": True, "sourceFiles": len(listed)}


def write_verified_copy(data, directory):
    # A descriptor to the checked private stage anchors the only output name.
    descriptor = os.open("code.tar.gz", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data); output.flush(); os.fsync(output.fileno())
    os.fsync(directory)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"--verify-stdin", "--copy-safe"}:
        raise ValueError("CODE_PACKAGE_ARGUMENTS_INVALID")
    # No CLI-controlled source or destination pathname reaches a file API.
    data = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
    result = verify_package(data, sys.argv[2])
    if sys.argv[1] == "--copy-safe":
        if not re.fullmatch(r"/opt/chogcare-stage-[A-Za-z0-9]{8}", os.getcwd()):
            raise ValueError("CODE_PACKAGE_STAGE_INVALID")
        directory = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(directory)
            if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
                raise ValueError("CODE_PACKAGE_STAGE_INVALID")
            write_verified_copy(data, directory)
        finally:
            os.close(directory)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:
        print("Code package verification failed; nothing was extracted.", file=sys.stderr)
        sys.exit(1)
