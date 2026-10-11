import test from "node:test";
import assert from "node:assert/strict";
import { acquireOperatorLease } from "../server/operator-lease.mjs";

test("operator lease excludes concurrent startup and maintenance for its full lifetime", async t => {
  // Dynamic test port only. Never use the real 4174/4175 worker ports.
  const first=await acquireOperatorLease(0);
  t.after(()=>first.close());
  const attempts=await Promise.allSettled([acquireOperatorLease(first.port),acquireOperatorLease(first.port)]);
  for(const attempt of attempts) {
    assert.equal(attempt.status,"rejected");
    assert.equal(attempt.reason.code,"EADDRINUSE");
  }
  await first.close();
  const successor=await acquireOperatorLease(first.port);
  t.after(()=>successor.close());
  assert.equal(successor.port,first.port);
  await assert.rejects(acquireOperatorLease(first.port),error=>error.code==="EADDRINUSE");
});
