import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { HDNodeWallet } from "ethers";
import { createCustodyVault, publicDepositNode, unlockCustodyVault, depositAddress, DEPOSIT_BASE_PATH } from "../server/custody-vault.mjs";
import { createAddressAllocator } from "../server/address-allocator.mjs";
import { paymentRequestUri } from "../server/payment-request.mjs";
import { createHash } from "node:crypto";

test("encrypted custody can recover child keys without putting secrets in the descriptor", async () => {
  const password = "test-only password not used for any real funds";
  const vault = await createCustodyVault(password);
  const recovered = await unlockCustodyVault(vault, password);
  assert.equal(publicDepositNode(vault).privateKey, undefined);
  assert.ok(!JSON.stringify(vault).includes(recovered.privateKey));
  assert.ok(!JSON.stringify(vault).includes(recovered.mnemonic.phrase));
  assert.equal(depositAddress(vault, 12), recovered.deriveChild(12).address);
  await assert.rejects(unlockCustodyVault(vault, "wrong password"));
  await assert.rejects(createCustodyVault("short"));
  assert.throws(() => publicDepositNode({ ...vault, xpub: recovered.extendedKey }));
  assert.throws(() => depositAddress(vault, -1));
  assert.throws(() => depositAddress(vault, 2 ** 31));
});

function testDescriptor() {
  const xpub = HDNodeWallet.createRandom("", DEPOSIT_BASE_PATH).neuter().extendedKey;
  return { version: 1, xpub, basePath: DEPOSIT_BASE_PATH, keyId: createHash("sha256").update(xpub).digest("hex") };
}
test("addresses are unique, stable on retry, and recoverable from persisted indices", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const vault = testDescriptor();
    const allocator = createAddressAllocator(db, vault);
    const first = allocator.allocate("invoice-one");
    assert.equal(allocator.allocate("invoice-one").address, first.address);
    const addresses = new Set([first.address]);
    for (let i = 0; i < 30; i++) addresses.add(allocator.allocate(`invoice-${i}`).address);
    assert.equal(addresses.size, 31);
    const restartedAllocator = createAddressAllocator(db, vault);
    assert.equal(restartedAllocator.allocate("invoice-one").address, first.address);
    assert.equal(restartedAllocator.allocate("after-restart").derivation_index, 31);
    assert.throws(() => createAddressAllocator(db, testDescriptor()), /mismatch/);
    assert.equal(allocator.allocate("invoice-one").address, first.address);
  } finally { db.close(); }
});
test("payment requests encode exact units and chain and cannot target token contracts", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const base = { depositAddress: address, chainId: 143 };
  assert.equal(paymentRequestUri({ ...base, mode: "nft", amount: "1" }), `ethereum:${address}@143?value=1000000000000000000`);
  assert.match(paymentRequestUri({ ...base, mode: "chog", amount: "300" }), /@143\/transfer\?address=0x1+&uint256=300000000000000000000$/);
  for (const change of [{ chainId: 1 }, { amount: "299" }, { amount: "300.0000000000000000001" }, { depositAddress: "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777" }]) {
    assert.throws(() => paymentRequestUri({ ...base, mode: "chog", amount: "300", ...change }));
  }
});
