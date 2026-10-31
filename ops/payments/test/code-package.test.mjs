import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fixture = String.raw`
import hashlib, io, json, pathlib, sys, tarfile, tempfile
source=json.load(sys.stdin)["validator"]
module={"__name__":"isolated_code_validator"};exec(compile(source,"isolated-code-validator","exec"),module)
verify=module["verify_package"]
files={"package.json":b"{}","package-lock.json":b"{}","scripts/cloud-payments.mjs":b"// synthetic code only\n"}
def archive(path,mode="valid"):
    manifest={"version":1,"files":[{"path":name,"sha256":hashlib.sha256(data).hexdigest()} for name,data in files.items()]}
    if mode=="tampered":manifest["files"][0]["sha256"]="f"*64
    with tarfile.open(path,"w:gz") as tar:
        def add(name,data):
            info=tarfile.TarInfo(name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
        for name,data in files.items():add(name,data)
        add("release-manifest.json",json.dumps(manifest).encode())
        if mode=="traversal":add("../escape.mjs",b"x")
        if mode=="private":add("work/payments/custody/vault.json",b"synthetic-not-a-vault")
        if mode=="unlisted":add("server/extra.mjs",b"x")
        if mode=="duplicate":add("package.json",b"{}")
        if mode=="symlink":
            info=tarfile.TarInfo("server/link.mjs");info.type=tarfile.SYMTYPE;info.linkname="/outside";tar.addfile(info)
    return hashlib.sha256(path.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix="chogcare-code-package-test-") as directory:
    path=pathlib.Path(directory)/"code.tar.gz";sha=archive(path)
    assert verify(path,sha)=={"verified":True,"codeOnly":True,"sourceFiles":3},"VALID_CODE_REJECTED"
    snapshot=pathlib.Path(directory)/"checked.tar.gz";verify(path,sha,snapshot)
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest()==sha and snapshot.stat().st_mode&0o077==0,"VERIFIED_COPY_INVALID"
    count=2
    for mode in ["traversal","private","unlisted","duplicate","symlink","tampered"]:
        sha=archive(path,mode)
        try:verify(path,sha)
        except Exception:count+=1
        else:raise AssertionError("UNSAFE_CODE_PACKAGE_ACCEPTED")
    sha=archive(path)
    try:verify(path,"0"*64)
    except Exception:count+=1
    else:raise AssertionError("WRONG_ARCHIVE_DIGEST_ACCEPTED")
print(json.dumps({"verified":True,"checks":count}))
`;

test("code package verifier rejects custody paths, traversal, links, duplicates, extra files and changed digests", { skip: process.platform === "win32" && process.env.CHOGCARE_STATION_WSL_TEST !== "1", timeout: 10000 }, () => {
  const windows = process.platform === "win32", binary = windows ? "C:\\Windows\\System32\\wsl.exe" : "/usr/bin/python3";
  const args = windows ? ["--exec", "/usr/bin/python3", "-c", fixture] : ["-c", fixture];
  const result = spawnSync(binary, args, { input: JSON.stringify({ validator: readFileSync(new URL("../verify-code-package.py", import.meta.url), "utf8") }), encoding: "utf8", timeout: 8000, maxBuffer: 1024, windowsHide: true });
  assert.equal(result.status, 0, "Isolated code archive validation failed; no production files are involved.");
  assert.deepEqual(JSON.parse(result.stdout), { verified: true, checks: 9 });
});
