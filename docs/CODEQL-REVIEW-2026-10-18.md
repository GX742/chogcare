# CodeQL follow-up — 18 October 2026

The first extended CodeQL run on public `main` (`26a23ed`) produced 19 JavaScript signals. Python and GitHub Actions analyses reported zero findings. The analysis includes local inputs such as command-line arguments, environment variables and local files, in addition to network input.

This document distinguishes code improvements from reviewed signals about intended local operations. Dismissing a reviewed signal does not mean that the original query produced no result. No production financial state was used for the investigation.

## Code changes

| Initial alerts | Investigation and change |
| --- | --- |
| #7: command executable derived from `process.env.SystemRoot` | Replaced the WSL executable with the fixed Windows system path already used by other native helpers; normalized SystemRoot, WINDIR, ComSpec and command search paths. A spoofed-environment regression checks both the worker environment and actual mocked system-service executable. This removes an unnecessary inherited-environment trust dependency. |
| #10, #13, #15, #16: metadata check followed by a separate pathname read | Added a bounded reader that opens once, validates the descriptor and matching pathname identity, rejects links and size/content changes, reads only that descriptor and always closes it. Applied to source scanning, recovery members and checkpoint reads. Regressions cover replacement after opening, oversized files, hard links and handle cleanup. Private parent-directory ACLs remain required. |
| #8: ambiguous analysis of URL `Array.includes` | Made exact origin membership explicit with a Set. The earlier code also compared complete array elements; it did not perform substring matching on a URL. |
| #9, #19: weak regular expression in a source assertion | Replaced the test's loose hostname expression with exact membership of extracted href values. Production hostname checks were not using this test expression. |

Additional findings from the review were fixed: the staged source guard now rejects Git index symlinks/non-regular modes, and the offline photo builder enforces a body limit during streaming rather than after an unbounded arrayBuffer. Newly downloaded art is decoded into metadata-free JPEG before persistence. These changes do not alter the already supplied project images.

## Reviewed local/test operations

The following dispositions retain the relevant trust assumptions. They are not a blanket suppression of a query or directory.

| Initial alerts | Disposition and evidence |
| --- | --- |
| #1, #2: supplied QA video filename | Intended local QA fixture selection. The operator supplies the file on the CLI; the HTTP server binds to loopback, and requests cannot choose that path. Its API responses are synthetic and cannot reach the payment worker. Review does not claim this tool can safely run with an attacker controlling the operator account or its arguments. |
| #3: offline recovery filename | The CLI resolves it directly under the fixed private backups directory, requires the same parent and canonical path, a regular bounded `.chogbackup`, and the exclusive operator lease. It cannot name an arbitrary file through the public API. Verification does not replace live financial state. |
| #4: Arduino font preview path | Trusted offline developer environment and library selection. It reads the operator's local Adafruit font headers; there is no network/serial/user-profile input to this path from the public application. |
| #5: executing extracted animation code | Test-only execution of this repository's reviewed UI hook inside a mocked context. The test is not a sandbox for external JavaScript and accepts no public request input. |
| #6: constructing a test regular expression | The expression is extracted from the UI source under test to exercise its COM-port validator. No public user controls it; modifying repository source already controls the test program. |
| #11: systemd credential check/read | Fixed root-managed read-only systemd credentials directory, expected service filename, owner, mode, size and link checks. There is no arbitrary public pathname. A process able to replace that systemd-managed credential is already inside the deployment trust boundary. |
| #12, #14, #17: checking before creating a file | These writes use atomic exclusive `wx` creation, so the existence check cannot cause an existing link/file to be opened for writing. Integrity updates use randomized exclusive temporary files and atomic rename. Operations are confined by the documented private storage/owner trust boundary. |
| #18: offline public-photo download | Deliberate download of fixed public project image URLs to fixed media paths. No payment/serial/API caller selects the URL or destination. Streaming byte, timeout and decoded-pixel limits apply; only transcoded JPEG data is persisted, never executable code. |

The local/test dispositions assume the operator's checkout, dependencies, account and command invocation are trusted. They do not make the application safe after an account or administrator compromise. The [main review](SECURITY-AUDIT-2026-10-18.md) records the remaining custody and host risks.

## Validation

The complete Node 24.22.0 regression run passed all 565 tests with zero failures or skips. New regressions exercise a file replaced after opening, hard links, byte limits and descriptor cleanup, a Git index symlink independent of Windows symlink privileges, an unlogged randomized credential canary, spoofed Windows system-directory variables and chunked/misleading-length image responses. All payment fixtures are disposable; no production custody unlock or transfer was performed.
