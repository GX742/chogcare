import { mkdir, open, readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCustodyVault, unlockCustodyVault } from "../server/custody-vault.mjs";

// Run personally in a terminal. Secrets never go through chat, browser, command
// arguments, VITE_* variables, request logs or a plaintext key file.
function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Use an interactive terminal. Passwords are not accepted from pipes or arguments.");
  return new Promise((resolvePrompt, reject) => {
    const previousRaw = process.stdin.isRaw;
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(previousRaw); process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolvePrompt(value);
      value = "";
    };
    const onData = chunk => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") { finish(new Error("Cancelled.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " " && value.length < 256) value += char;
      }
    };
    process.stdout.write(label); process.stdin.setEncoding("utf8"); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

const filename = resolve("work/payments/custody/vault.json");
try {
  if (process.argv.includes("--check")) {
    const bundle = JSON.parse(await readFile(filename, "utf8"));
    let password = await hiddenPrompt("Custody backup password (hidden): ");
    await unlockCustodyVault(bundle, password); password = "";
    console.log("Encrypted backup recovery verified. No transactions were signed or sent.");
  } else {
    let exists = false;
    try { await access(filename); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (exists) throw new Error("Custody backup already exists. Never overwrite it. Use npm run payments:vault:check.");
    console.log("Create a NEW dedicated ChogCare custody backup. This does not enable payments.");
    console.log("Keep a separate backup of the encrypted file and store its password in a password manager. Never send either in chat.");
    let password = await hiddenPrompt("New unique password, minimum 16 characters (hidden): ");
    let confirmation = await hiddenPrompt("Repeat password (hidden): ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    confirmation = "";
    const bundle = await createCustodyVault(password); password = "";
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    const file = await open(filename, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(bundle), "utf8"); await file.sync(); } finally { await file.close(); }
    console.log(`Encrypted backup saved: ${filename}`);
    console.log("Recovery verified. No private key or seed was printed. Do not fund any derived address yet: settlement is not connected.");
  }
} catch (error) {
  // All intentional errors are secret-free. Never dump third-party objects or stacks.
  console.error(error instanceof Error && /password|backup|Cancelled|terminal|Custody/i.test(error.message) ? error.message : "Could not prepare custody backup. No payments have been enabled.");
  process.exitCode = 1;
}
