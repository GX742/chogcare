import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contractsDir = path.join(root, "contracts");
const artifactsDir = path.join(root, "artifacts");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sources = Object.fromEntries(
  walk(contractsDir)
    .filter((file) => file.endsWith(".sol"))
    .map((file) => [path.relative(root, file).replaceAll("\\", "/"), { content: fs.readFileSync(file, "utf8") }]),
);

function findImports(importPath) {
  const candidates = [
    path.join(root, importPath),
    path.join(root, "node_modules", importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, "utf8") };
  }
  return { error: `Import not found: ${importPath}` };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    viaIR: true,
    evmVersion: "shanghai",
    optimizer: { enabled: true, runs: 500 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors || []).filter((item) => item.severity === "error");
for (const diagnostic of output.errors || []) console.log(diagnostic.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(artifactsDir, { recursive: true });
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!artifact.evm.bytecode.object) continue;
    fs.writeFileSync(
      path.join(artifactsDir, `${contractName}.json`),
      JSON.stringify({ contractName, sourceName, abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` }, null, 2),
    );
  }
}

console.log(`Compiled ${Object.keys(output.contracts).length} source units.`);
