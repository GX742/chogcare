# OBS authentication CodeQL review

This records the evidence for a reviewer to adjudicate one protocol finding.
It does not suppress queries, change check policy or dismiss a GitHub alert.

## Exact finding and data flow

PR 46 at `6f43236239496836145e6438995d16e72ddbba56` produced
[alert 29](https://github.com/GX742/chogcare/security/code-scanning/29),
`js/insufficient-password-hash`, in `ops/stream/obs-client.mjs` at the
SHA-256 update originally on line 3. CodeQL SARIF analysis `2068906791`
records the production flow from the `connectLocalObs` password argument,
through `password + auth.salt`, into the digest helper. The result also
includes synthetic password arguments from `test/obs-client.test.mjs`.

The client computes:

```text
secret = base64(SHA256(password + serverSalt))
authentication = base64(SHA256(secret + serverChallenge))
```

The authentication value is sent in the OBS `Identify` message. The client
does not write the password, secret or authentication value to disk or logs.
Its endpoint is fixed to IPv4 loopback, and it refuses an unauthenticated
server. Those constraints are part of the reviewed code, not capabilities
inferred from a test name.

## Protocol requirement and disposition

The [OBS WebSocket 5.6.3 protocol, “Creating an authentication string”](https://github.com/obsproject/obs-websocket/blob/5.6.3/docs/generated/protocol.md#creating-an-authentication-string)
specifies both SHA-256/base64 operations above. Replacing either operation
with a password-storage KDF would make the client incompatible with OBS.

[CodeQL's query documentation](https://codeql.github.com/codeql-query-help/javascript/js-insufficient-password-hash/)
addresses application password-hash storage and recommends a costly KDF.
This client implements the required challenge exchange instead of storing
password hashes. The proposed disposition is a narrowly scoped false
positive for that storage concern, subject to the repository owner's
review of alert 29 after the other findings are resolved.

This does not claim that OBS's protocol gains password-stretching resistance.
A captured challenge exchange with a weak password can still allow guessing;
compatibility with a required protocol is not proof of broader cryptographic
security. Password generation and local OBS access controls remain separate
operator responsibilities.

## Verification and related fixes

The OBS test now checks an independently calculated synthetic known-answer
value, rather than duplicating the production hashing implementation. It
also checks that RPC requires authentication and that failures do not expose
arbitrary server comments. The production hashing behavior remains unchanged.

The MediaMTX integration test uses a separate fixed synthetic credential
vector to exercise the renderer's explicitly supported SHA-256 credential
format. This introduces no real publisher password into source. The binary
race finding is fixed by a bounded descriptor-based regular-file read,
verification of those bytes and exclusive creation of the owned executable
snapshot used by the fixture. These changes do not suppress the remaining
production OBS protocol finding.
