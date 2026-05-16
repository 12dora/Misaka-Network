globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('credentials/generate')) {
    return new Response(JSON.stringify({
      iceServers: [{
        urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'stub-user',
        credential: 'stub-pass',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/graphql')) {
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [
        { sum: { egressBytes: 1234, ingressBytes: 4321 }, dimensions: { customIdentifier: 'stub-cf-month' } },
      ] }] } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (href.includes('/revoke')) {
    return new Response('{}', { status: 200 })
  }
  return fetch(url)
}
