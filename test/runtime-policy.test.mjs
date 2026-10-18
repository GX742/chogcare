import test from "node:test";
import assert from "node:assert/strict";
import { supportedPaymentNode } from "../admin/runtime-policy.mjs";

test("payment runtime accepts the tested LTS line only", () => {
  for (const version of ["v24.22.0", "v24.22.1\n", "v24.23.0"]) assert.equal(supportedPaymentNode(version), true);
  for (const version of ["v24.21.0", "v25.9.0", "v26.12.0", "v22.0.0", "v24.22.0-evil", "v24.22.0\nwrong", null]) assert.equal(supportedPaymentNode(version), false);
});
