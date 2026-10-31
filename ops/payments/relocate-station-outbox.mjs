import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireOperatorLease } from "../../server/operator-lease.mjs";
import { relocateStationOutbox } from "../../server/station-outbox-relocation.mjs";

// Destination maintenance only, after verified financial relocation and before
// either cloud service starts. No vault read, signer, transfer or DB reset.
export async function relocateCloudStationOutbox() {
  let lease; const probes = [];
  try {
    lease = await acquireOperatorLease();
    for (const port of [4174, 4176]) {
      const probe = createServer();
      await new Promise((ok, bad) => { probe.once("error", bad); probe.listen(port, "127.0.0.1", ok); }); probes.push(probe);
    }
    return relocateStationOutbox({
      stationSnapshot: "/var/lib/chogcare-station/station.source.sqlite",
      stationFilename: "/var/lib/chogcare-station/station.sqlite",
      sourceCheckpoint: "/var/lib/chogcare/work/payments/integrity/checkpoint.source.json",
      processorFilename: "/var/lib/chogcare/work/payments/processor.sqlite",
      profileFilename: "/var/lib/chogcare/work/payments/preview.sqlite",
      checkpointFilename: "/var/lib/chogcare/work/payments/integrity/checkpoint.json",
    });
  } finally { for (const probe of probes.reverse()) await new Promise(ok => probe.close(ok)); await lease?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.slice(2).join(" ") !== "--verify-relocation") throw Error("Explicit station relocation is required."); console.log(JSON.stringify(await relocateCloudStationOutbox())); }
  catch { console.error("Station outbox relocation failed. Preserve its source snapshot and financial checkpoints; no custody was started. Do not initialize a fresh outbox to bypass this check."); process.exitCode = 1; }
}
