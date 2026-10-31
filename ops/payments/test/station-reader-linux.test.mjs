import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Real Linux permissions, UID isolation and WAL recreation on disposable data.
// No users, services, production paths, keys or network listeners are changed.
const fixture = String.raw`
import ctypes, json, os, pathlib, sqlite3, stat, subprocess, sys, tempfile
def require(value, code):
    if not value: raise AssertionError(code)
require(os.geteuid()==0, "ISOLATED_UID_TEST_REQUIRES_ROOT")
library=ctypes.CDLL("libacl.so.1",use_errno=True)
library.acl_from_text.argtypes=[ctypes.c_char_p];library.acl_from_text.restype=ctypes.c_void_p
library.acl_set_file.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p];library.acl_set_file.restype=ctypes.c_int
library.acl_free.argtypes=[ctypes.c_void_p];library.acl_free.restype=ctypes.c_int
def acl(path, text, default=False):
    value=library.acl_from_text(text.encode());require(value,"ISOLATED_ACL_PARSE_FAILED")
    try:require(library.acl_set_file(os.fsencode(path),0x4000 if default else 0x8000,value)==0,"ISOLATED_ACL_FAILED")
    finally:library.acl_free(value)
with tempfile.TemporaryDirectory(prefix="chogcare-station-reader-test-") as directory:
    base=pathlib.Path(directory);private=base/"payments";private.mkdir(mode=0o700)
    custody=private/"custody";custody.mkdir(mode=0o700);secret=custody/"vault.json";secret.write_text("synthetic-only");secret.chmod(0o600)
    dbfile=private/"processor.sqlite";dbfile.touch(mode=0o600)
    writer=sqlite3.connect(dbfile);writer.execute("PRAGMA journal_mode=WAL");writer.execute("CREATE TABLE fixture(value INTEGER)");writer.execute("INSERT INTO fixture VALUES(1)");writer.commit()
    for directory_path in [base,private]:acl(directory_path,"u::rwx,u:65534:--x,g::---,m::--x,o::---")
    for file in [dbfile,pathlib.Path(str(dbfile)+"-wal"),pathlib.Path(str(dbfile)+"-shm")]:acl(file,"u::rw-,u:65534:r--,g::---,m::r--,o::---")
    acl(private,"u::rwx,u:65534:r--,g::---,m::r--,o::---",default=True)
    reader_code='''
import os, sqlite3, sys
os.setgroups([]);os.setgid(65534);os.setuid(65534)
try:
    db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)
    db.execute("PRAGMA query_only=ON")
    assert db.execute("SELECT COUNT(*) FROM fixture").fetchone()[0]==int(sys.argv[3])
    try:db.execute("UPDATE fixture SET value=9");raise AssertionError("write allowed")
    except sqlite3.OperationalError:pass
    try:open(sys.argv[2]).read();raise AssertionError("custody readable")
    except PermissionError:pass
    db.close()
except Exception:sys.exit(1)
'''
    def read(count):
        result=subprocess.run([sys.executable,"-c",reader_code,str(dbfile),str(secret),str(count)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=4)
        return result.returncode==0
    require(read(1),"INITIAL_READONLY_READER_FAILED")
    writer.close()
    require(not pathlib.Path(str(dbfile)+"-wal").exists(),"WAL_WAS_NOT_RECREATED")
    writer=sqlite3.connect(dbfile);writer.execute("PRAGMA journal_mode=WAL");writer.execute("INSERT INTO fixture VALUES(2)");writer.commit()
    for suffix in ["-wal","-shm"]:
        file=pathlib.Path(str(dbfile)+suffix)
        require(file.exists() and stat.S_IMODE(file.stat().st_mode)&0o077==0o040,"RECREATED_JOURNAL_MODE_INVALID")
    require(read(2),"RECREATED_WAL_SHM_READER_FAILED")
    wal=pathlib.Path(str(dbfile)+"-wal")
    acl(wal,"u::rw-,g::---,o::---")
    require(not read(2),"MISSING_WAL_ACCESS_DID_NOT_FAIL_CLOSED")
    writer.close()
print(json.dumps({"verified":True,"readonly":True,"custodyIsolated":True,"walRecreated":True,"missingAclFailsClosed":True}))
`;

test("separate station UID reads recreated Linux SQLite WAL/SHM without custody or financial writes", { skip: process.platform === "win32" && process.env.CHOGCARE_STATION_WSL_TEST !== "1", timeout: 20000 }, () => {
  const windows = process.platform === "win32", root = process.getuid?.() === 0;
  const binary = windows ? "C:\\Windows\\System32\\wsl.exe" : root ? "/usr/bin/python3" : "/usr/bin/sudo";
  const args = windows ? ["--user", "root", "--exec", "/usr/bin/python3", "-c", fixture] : root ? ["-c", fixture] : ["-n", "/usr/bin/python3", "-c", fixture];
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 18000, maxBuffer: 2048, windowsHide: true });
  const failure = (result.stderr ?? "").match(/ISOLATED_[A-Z_]+|INITIAL_READONLY_READER_FAILED|WAL_WAS_NOT_RECREATED|RECREATED_JOURNAL_MODE_INVALID|RECREATED_WAL_SHM_READER_FAILED|MISSING_WAL_ACCESS_DID_NOT_FAIL_CLOSED/)?.[0] ?? "ISOLATED_FIXTURE_FAILED";
  assert.equal(result.status, 0, `${failure}: disposable Linux ACL/SQLite integration failed; never inspect live custody state for this fixture.`);
  assert.deepEqual(JSON.parse(result.stdout), { verified: true, readonly: true, custodyIsolated: true, walRecreated: true, missingAclFailsClosed: true });
});
