import { createServer } from "node:net";

// Covers password entry, schema setup and shutdown, when HTTP may not listen yet.
// Same-account malware can bypass this convention; it is a concurrency guard.
export async function acquireOperatorLease(port=4175) {
  const server=createServer(socket=>socket.destroy());
  await new Promise((ok,bad)=>{server.once("error",bad);server.listen(port,"127.0.0.1",ok);});
  return {close:()=>new Promise(ok=>server.close(ok)),port:server.address().port};
}
