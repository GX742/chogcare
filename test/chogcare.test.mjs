import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { BrowserProvider, ContractFactory, MaxUint256, parseUnits, Wallet, ZeroHash } from "ethers";

const root = process.cwd();
const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, "artifacts", `${name}.json`), "utf8"));

async function deploy(name, signer, args = []) {
  const { abi, bytecode } = artifact(name);
  const contract = await new ContractFactory(abi, bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

describe("ChogCare end-to-end", () => {
  let provider;
  let admin;
  let adminVoucherSigner;
  let donor;
  let recipient;
  let attacker;
  let chog;
  let usdc;
  let receiver;
  let bridge;
  let source;
  let chainId;
  let connection;

  before(async () => {
    connection = await network.create({ network: "hardhatMainnet" });
    provider = new BrowserProvider(connection.provider);
    admin = await provider.getSigner(0);
    adminVoucherSigner = Wallet.createRandom(); // Ephemeral test-only signer, never custody.
    donor = await provider.getSigner(1);
    recipient = await provider.getSigner(2);
    attacker = await provider.getSigner(3);
    chainId = Number((await provider.getNetwork()).chainId);

    chog = await deploy("MockERC20", admin, ["Chog", "CHOG", 18]);
    usdc = await deploy("MockERC20", admin, ["USD Coin", "USDC", 6]);
    const swap = await deploy("MockSwapAdapter", admin, [2_000n, 18]);
    bridge = await deploy("MockBridgeAdapter", admin);
    receiver = await deploy("ChogCareReceiver", admin, [await admin.getAddress(), await usdc.getAddress()]);

    source = await deploy("ChogCareSource", admin, [
      await admin.getAddress(),
      await chog.getAddress(),
      await usdc.getAddress(),
      await swap.getAddress(),
      await bridge.getAddress(),
      1,
      await receiver.getAddress(),
    ]);
    await (await source.grantRole(await source.SUBSIDY_SIGNER_ROLE(), adminVoucherSigner.address)).wait();

    const bridgeRole = await receiver.BRIDGE_ROLE();
    await (await receiver.grantRole(bridgeRole, await bridge.getAddress())).wait();
    await (await receiver.setRecipientAllowed(await recipient.getAddress(), true)).wait();
    await (await source.setRecipientAllowed(await recipient.getAddress(), true)).wait();

    await (await chog.mint(await donor.getAddress(), parseUnits("1000", 18))).wait();
    await (await usdc.mint(await swap.getAddress(), parseUnits("1000", 6))).wait();
    await (await usdc.mint(await source.getAddress(), parseUnits("10", 6))).wait();
    await (await chog.connect(donor).approve(await source.getAddress(), MaxUint256)).wait();
  });
  after(async () => { provider?.destroy(); await connection?.close(); });

  it("swaps, adds a signed $0.50 subsidy and forwards USDC to the allowlisted recipient", async () => {
    const now = Math.floor(Date.now() / 1000);
    const voucher = {
      donor: await donor.getAddress(),
      amount: 500_000n,
      nonce: 7n,
      deadline: BigInt(now + 3600),
    };
    const domain = {
      name: "ChogCare",
      version: "1",
      chainId,
      verifyingContract: await source.getAddress(),
    };
    const types = {
      SubsidyVoucher: [
        { name: "donor", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const signature = await adminVoucherSigner.signTypedData(domain, types, voucher);
    const request = {
      chogAmount: parseUnits("100", 18),
      minUsdcOut: 200_000n,
      recipient: await recipient.getAddress(),
      projectId: "0x" + "11".repeat(32),
      deadline: now + 3600,
      swapData: "0x",
      bridgeData: "0x",
    };

    const beforeBalance = await usdc.balanceOf(await recipient.getAddress());
    await (await source.connect(donor).donate(request, voucher, signature)).wait();
    const afterBalance = await usdc.balanceOf(await recipient.getAddress());
    assert.equal(afterBalance - beforeBalance, 700_000n);
    assert.equal(await source.usedVoucher(await donor.getAddress(), 7n), true);
  });

  it("rejects voucher replay", async () => {
    const now = Math.floor(Date.now() / 1000);
    const voucher = { donor: await donor.getAddress(), amount: 500_000n, nonce: 8n, deadline: BigInt(now + 3600) };
    const domain = { name: "ChogCare", version: "1", chainId, verifyingContract: await source.getAddress() };
    const types = { SubsidyVoucher: [
      { name: "donor", type: "address" }, { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    const signature = await adminVoucherSigner.signTypedData(domain, types, voucher);
    const request = {
      chogAmount: parseUnits("1", 18), minUsdcOut: 2_000n,
      recipient: await recipient.getAddress(), projectId: ZeroHash,
      deadline: now + 3600, swapData: "0x", bridgeData: "0x",
    };
    await (await source.connect(donor).donate(request, voucher, signature)).wait();
    const beforeReplay = await usdc.balanceOf(await recipient.getAddress());
    await assert.rejects(async () => {
      await (await source.connect(donor).donate(request, voucher, signature)).wait();
    });
    assert.equal(await usdc.balanceOf(await recipient.getAddress()), beforeReplay);
  });

  it("rejects an unapproved recipient before taking CHOG", async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = {
      chogAmount: parseUnits("1", 18), minUsdcOut: 1n,
      recipient: await attacker.getAddress(), projectId: ZeroHash,
      deadline: now + 3600, swapData: "0x", bridgeData: "0x",
    };
    const emptyVoucher = { donor: await donor.getAddress(), amount: 0n, nonce: 0n, deadline: 0n };
    const beforeBalance = await chog.balanceOf(await donor.getAddress());
    await assert.rejects(async () => {
      await (await source.connect(donor).donate(request, emptyVoucher, "0x")).wait();
    });
    assert.equal(await chog.balanceOf(await donor.getAddress()), beforeBalance);
  });

  it("prevents non-admin recipient changes", async () => {
    await assert.rejects(async () => {
      await (await source.connect(attacker).setRecipientAllowed(await attacker.getAddress(), true)).wait();
    });
  });

  it("rejects unauthorized adapter, bridge-role, pause and treasury changes", async () => {
    const address = await attacker.getAddress();
    await assert.rejects(source.connect(attacker).setSwapAdapter.staticCall(await bridge.getAddress()));
    await assert.rejects(source.connect(attacker).setBridgeRoute.staticCall(await bridge.getAddress(), 1, address));
    await assert.rejects(source.connect(attacker).pause.staticCall());
    await assert.rejects(source.connect(attacker).grantRole.staticCall(await source.MANAGER_ROLE(), address));
    await assert.rejects(receiver.connect(attacker).setRecipientAllowed.staticCall(address, true));
    await assert.rejects(receiver.connect(attacker).completeDonation.staticCall(ZeroHash, address, await recipient.getAddress(), ZeroHash, 1n));
    await assert.rejects(source.connect(attacker).recoverToken.staticCall(await usdc.getAddress(), address, 1n));
    await assert.rejects(receiver.connect(attacker).pause.staticCall());
    await assert.rejects(source.setSwapAdapter.staticCall(address)); // EOA cannot be adapter.
  });

  it("paused source and invalid amount/deadline/slippage preserve donor funds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = { chogAmount: parseUnits("1", 18), minUsdcOut: 2_000n, recipient: await recipient.getAddress(), projectId: ZeroHash, deadline: now + 3600, swapData: "0x", bridgeData: "0x" };
    const empty = { donor: await donor.getAddress(), amount: 0n, nonce: 0n, deadline: 0n };
    const balance = await chog.balanceOf(await donor.getAddress());
    await (await source.pause()).wait();
    try { await assert.rejects(source.connect(donor).donate.staticCall(request, empty, "0x")); }
    finally { await (await source.unpause()).wait(); }
    for (const change of [{ chogAmount: 0n }, { deadline: 1 }, { minUsdcOut: 999_999_999n }]) {
      await assert.rejects(source.connect(donor).donate.staticCall({ ...request, ...change }, empty, "0x"));
    }
    assert.equal(await chog.balanceOf(await donor.getAddress()), balance);
    await assert.rejects(source.recoverToken.staticCall(await usdc.getAddress(), await admin.getAddress(), 1n));
  });

  it("voucher bounds, expiry, donor, signer and domain are enforced without consuming nonces", async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = { chogAmount: parseUnits("1", 18), minUsdcOut: 2_000n, recipient: await recipient.getAddress(), projectId: ZeroHash, deadline: now + 3600, swapData: "0x", bridgeData: "0x" };
    const domain = { name: "ChogCare", version: "1", chainId, verifyingContract: await source.getAddress() };
    const types = { SubsidyVoucher: [{ name: "donor", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
    const voucher = { donor: await donor.getAddress(), amount: 500_000n, nonce: 40n, deadline: BigInt(now + 3600) };
    const stranger = Wallet.createRandom();
    const cases = [
      [{ ...voucher, amount: 500_001n }, domain, adminVoucherSigner],
      [{ ...voucher, deadline: 1n }, domain, adminVoucherSigner],
      [{ ...voucher, donor: await attacker.getAddress() }, domain, adminVoucherSigner],
      [voucher, { ...domain, chainId: chainId + 1 }, adminVoucherSigner],
      [voucher, { ...domain, verifyingContract: await receiver.getAddress() }, adminVoucherSigner],
      [voucher, domain, stranger],
    ];
    for (const [v, d, signer] of cases) {
      const signature = await signer.signTypedData(d, types, v);
      await assert.rejects(source.connect(donor).donate.staticCall(request, v, signature));
    }
    assert.equal(await source.usedVoucher(await donor.getAddress(), 40n), false);
  });

  it("receiver blocks replay and paused delivery and restores state on failed transfer", async () => {
    const bridgeRole = await receiver.BRIDGE_ROLE();
    const adminAddress = await admin.getAddress();
    const donorAddress = await donor.getAddress();
    const recipientAddress = await recipient.getAddress();
    const id = "0x" + "88".repeat(32);
    await (await receiver.grantRole(bridgeRole, adminAddress)).wait();
    try {
      await assert.rejects(receiver.completeDonation.staticCall(id, donorAddress, recipientAddress, ZeroHash, 1n));
      assert.equal(await receiver.processedDonations(id), false);
      await (await usdc.mint(await receiver.getAddress(), 1n)).wait();
      await (await receiver.pause()).wait();
      await assert.rejects(receiver.completeDonation.staticCall(id, donorAddress, recipientAddress, ZeroHash, 1n));
      await (await receiver.unpause()).wait();
      await (await receiver.completeDonation(id, donorAddress, recipientAddress, ZeroHash, 1n)).wait();
      assert.equal(await receiver.processedDonations(id), true);
      await assert.rejects(receiver.completeDonation.staticCall(id, donorAddress, recipientAddress, ZeroHash, 1n));
    } finally { await (await receiver.revokeRole(bridgeRole, adminAddress)).wait(); }
  });
});
