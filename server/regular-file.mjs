import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";

// Validate and read the same opened file, not a path that can be replaced
// between lstat and readFile. Private parent-directory ACLs remain necessary.
export function readRegularFileSync(path, maximum = 1024 * 1024, { open = openSync, validate = () => {} } = {}) {
  if (typeof path !== "string" || /^[\\/]{2}/.test(path) || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 128 * 1024 * 1024) throw Error("Unsafe regular file read.");
  const fd = open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    const before = fstatSync(fd, { bigint: true });
    const matches = () => {
      const current = lstatSync(path, { bigint: true });
      return current.isFile() && !current.isSymbolicLink() && current.nlink === 1n && current.dev === before.dev && current.ino === before.ino;
    };
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum) || !matches()) throw Error("Unsafe regular file read.");
    validate(before);
    bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (BigInt(offset) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || !matches()) throw Error("Regular file changed during reading.");
    validate(after);
    return bytes.subarray(0, offset);
  } catch (error) { bytes?.fill(0); throw error; }
  finally { closeSync(fd); }
}
