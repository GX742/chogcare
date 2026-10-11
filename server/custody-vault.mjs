import { createHash } from "node:crypto";
import { HDNodeWallet, Wallet } from "ethers";

export const DEPOSIT_BASE_PATH = "m/44'/60'/0'/0";
const fingerprint = xpub => createHash("sha256").update(xpub).digest("hex");

export async function createCustodyVault(password) {
  if (typeof password !== "string" || password.length < 16 || password.length > 256) throw new Error("Use a unique password of 16 to 256 characters.");
  const root = HDNodeWallet.createRandom("", DEPOSIT_BASE_PATH);
  const xpub = root.neuter().extendedKey;
  const vault = {
    version: 1, basePath: DEPOSIT_BASE_PATH, xpub, keyId: fingerprint(xpub),
    encryptedKeystore: await root.encrypt(password),
  };
  // Verify recovery before the CLI writes anything. Never return an unverified backup.
  const recovered = await unlockCustodyVault(vault, password);
  if (recovered.neuter().extendedKey !== xpub) throw new Error("Wallet recovery verification failed.");
  return vault;
}

export function publicDepositNode(vault) {
  if (vault?.version !== 1 || vault.basePath !== DEPOSIT_BASE_PATH || typeof vault.xpub !== "string" || !vault.xpub.startsWith("xpub") || fingerprint(vault.xpub) !== vault.keyId) throw new Error("Invalid custody descriptor.");
  const node = HDNodeWallet.fromExtendedKey(vault.xpub);
  if ("privateKey" in node || node.depth !== 4) throw new Error("Address allocator requires a public-only deposit branch.");
  return node;
}

export async function unlockCustodyVault(vault, password) {
  publicDepositNode(vault);
  if (typeof vault.encryptedKeystore !== "string") throw new Error("Encrypted custody backup is missing.");
  let root;
  try { root = await Wallet.fromEncryptedJson(vault.encryptedKeystore, password); }
  catch { throw new Error("Cannot unlock custody backup. Check your password and backup file."); }
  if (!(root instanceof HDNodeWallet) || root.path !== DEPOSIT_BASE_PATH || root.neuter().extendedKey !== vault.xpub) throw new Error("Custody backup does not match the pinned address branch.");
  return root;
}

// No private key is needed to derive an invoice address. Caller persists the index
// before exposing the address. This alone does NOT make a payment service operational.
export function depositAddress(vault, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) throw new Error("Invalid deposit index.");
  return publicDepositNode(vault).deriveChild(index).address;
}
