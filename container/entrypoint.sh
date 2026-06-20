#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# OneCLI gateway is a TLS-intercepting proxy. It exports SSL_CERT_FILE (curl) and
# NODE_EXTRA_CA_CERTS (node) so those trust the intercept CA — but git reads
# neither, and gh won't call the API without a token present. Point git at the
# same combined CA, and give gh a non-empty placeholder token (the gateway
# injects the real PAT for agents scoped to GitHub; agents without that scope
# simply get no injection and gh fails closed). Harmless for non-git agents.
export GIT_SSL_CAINFO="${SSL_CERT_FILE:-/tmp/onecli-combined-ca.pem}"
export GH_TOKEN="${GH_TOKEN:-onecli-gateway}"

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
