import {cp,mkdir,mkdtemp,readdir,readFile,writeFile,lstat} from "node:fs/promises";
import {resolve,join,dirname,relative} from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";

// Code-only package. No work/, .env, vault, checkpoint, database or logs can
// enter it. The existing custody state is transferred separately, offline.
const workspace=resolve("."),output=resolve("work/server-release");await mkdir(output,{recursive:true});
const stage=await mkdtemp(join(output,"payment-server-"));
const scripts=["start-payments.mjs","terminal-password.mjs","cloud-payments.mjs","relocate-payment-checkpoint.mjs","payment-integrity.mjs","payment-recovery.mjs","station-remote-client.mjs","station-broadcast-remote.mjs","check-station-remote-acl.ps1"];
const operations=["package.json","package-lock.json","chogcare-payments.service","nginx.conf","readiness-preflight.mjs","retire-host.mjs","station-service.mjs","chogcare-station.service","configure-station-reader.sh","relocate-station-outbox.mjs","provision-stage.sh","verify-code-package.py","CUTOVER.md","test/readiness-preflight.test.mjs","test/station-reader-linux.test.mjs","test/code-package.test.mjs"];
const files=[...operations.map(name=>`ops/payments/${name}`),"docs/PAYMENT-SERVER.md","test/station-remote.test.mjs","test/station-broadcast-remote.test.mjs","test/payment-host-retirement.test.mjs","test/payment-host-readiness.test.mjs",...scripts.map(name=>`scripts/${name}`)];
for(const [directory,extension] of [["server",".mjs"],["src",".ts"]]){
  for(const name of await readdir(directory))if(name.endsWith(extension))files.push(`${directory}/${name}`);
}
for(const file of files){
  const source=resolve(file),metadata=await lstat(source);
  if(!metadata.isFile()||metadata.isSymbolicLink())throw Error("Only regular source files may be packaged.");
  const destination=join(stage,file.startsWith("ops/payments/package")?file.slice("ops/payments/".length):file);
  await mkdir(dirname(destination),{recursive:true});await cp(source,destination,{errorOnExist:true,force:false});
}
const manifest=[];
for(const file of files){const path=file.startsWith("ops/payments/package")?file.slice("ops/payments/".length):file;manifest.push({path,sha256:createHash("sha256").update(await readFile(join(stage,path))).digest("hex")});}
await writeFile(join(stage,"release-manifest.json"),JSON.stringify({version:1,files:manifest},null,2));
const archive=stage+".tar.gz";
execFileSync("tar",["-czf",archive,"-C",stage,"."],{stdio:"inherit"});
console.log(JSON.stringify({archive:relative(workspace,archive),stage:relative(workspace,stage),sourceFiles:files.length,containsCustody:false}));
