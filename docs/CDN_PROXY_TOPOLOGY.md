# CDN / reverse-proxy client IP topology

The supplied production stack assumes exactly one trusted hop:

`internet → Caddy → signaling`, with `TRUST_PROXY=1`.

Do not put a CDN in front of the supplied Caddyfile unchanged.
`{http.request.remote.host}` would then be the CDN edge address, not the user,
and every user behind an edge could share rate limits and abuse state.

For a CDN deployment:

1. Obtain the current proxy CIDRs from the CDN's official machine-readable
   source and keep them updated automatically.
2. Configure Caddy's global `trusted_proxies` with only those CIDRs and enable
   strict client-IP parsing. Never trust forwarded headers from arbitrary
   internet peers.
3. Set the upstream `X-Forwarded-For`/`X-Real-IP` from Caddy's validated
   `{client_ip}`, not `{http.request.remote.host}`.
4. Keep signaling private behind Caddy. Set `TRUST_PROXY=1`, because Caddy
   emits one sanitized client address; do not count the public CDN chain again.
5. Run `deploy/verify-proxy-trust.sh` in burst mode and `--fresh` from another
   network. Inspect both HTTP and WebSocket handshakes before enabling traffic.

Exact Caddy directives depend on the deployed Caddy version and CDN. Validate
the configuration against their current official documentation instead of
copying a stale CIDR list into this repository.
