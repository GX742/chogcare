// npm test discovers root test/*.test.mjs; keep the staged package's standalone
// host/permission/archive suites covered by the same required Linux CI run.
import "../ops/payments/test/readiness-preflight.test.mjs";
import "../ops/payments/test/station-reader-linux.test.mjs";
import "../ops/payments/test/code-package.test.mjs";
