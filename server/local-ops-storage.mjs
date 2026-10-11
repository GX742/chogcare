import { execFileSync } from "node:child_process";
import { mkdirSync, lstatSync, realpathSync, readdirSync, chmodSync } from "node:fs";
import { resolve, join, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const matches = (pattern, value) => value.match(pattern)?.[0] === value;
const fileAllowed = (kind, name) => kind === "support"
  ? matches(/^support\.sqlite(?:-(?:wal|shm|journal))?$/, name)
  : name === "settings.json" || matches(/^settings-[a-f0-9]{24}\.tmp$/, name);

// Trusted main-process initialization only. It accepts no renderer-controlled
// target and never changes work/payments, the repository, or a recursive tree.
export function initLocalOpsDirectory(workspacePath, kind, dependencies = {}) {
  if (!["support", "admin"].includes(kind) || typeof workspacePath !== "string" || !isAbsolute(workspacePath) || /^[\\/]{2}/.test(workspacePath) || resolve(workspacePath).startsWith("\\\\")) throw new Error("Invalid local operations storage scope.");
  const platform = dependencies.platform ?? process.platform, chmod = dependencies.chmod ?? chmodSync, run = dependencies.run ?? execFileSync;
  const workspace = realpathSync(workspacePath);
  if (workspace.startsWith("\\\\") || !lstatSync(workspace).isDirectory() || lstatSync(workspace).isSymbolicLink()) throw new Error("Local operations workspace must be a regular directory.");
  let directory = workspace;
  for (const component of ["work", kind]) {
    directory = join(directory, component);
    try { mkdirSync(directory, { recursive: false, mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(directory, realpathSync(directory))) throw new Error("Local operations storage must not be linked.");
  }
  const inside = relative(workspace, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Invalid local operations storage scope.");
  const files = readdirSync(directory).map(name => {
    const filename = join(directory, name), metadata = lstatSync(filename);
    if (!fileAllowed(kind, name) || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || relative(filename, realpathSync(filename))) throw new Error("Unexpected local operations storage item.");
    return filename;
  });
  if (platform === "win32") {
    const script = fileURLToPath(new URL("../scripts/protect-local-ops-storage.ps1", import.meta.url)), metadata = lstatSync(script);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw new Error("Local operations ACL utility is unavailable.");
    try {
      run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-WorkspacePath", workspace, "-Kind", kind], {
        shell: false, windowsHide: true, timeout: 15000, maxBuffer: 8192, stdio: "ignore",
      });
    } catch { throw new Error("Local operations storage permissions could not be protected. No inbox was opened."); }
  } else {
    chmod(directory, 0o700);
    for (const filename of files) chmod(filename, 0o600);
  }
  return directory;
}
