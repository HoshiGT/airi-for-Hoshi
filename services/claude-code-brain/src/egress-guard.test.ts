import { describe, expect, it, vi } from 'vitest'

import { confirmStartDespiteEgress, decideEgress, parseAllowedEgressIps, probeEgressIp } from './egress-guard'

function okResponse(body: string) {
  return { ok: true, status: 200, text: async () => body } as Response
}

describe('parseAllowedEgressIps', () => {
  it('splits on commas and whitespace, trims, and dedupes', () => {
    expect(parseAllowedEgressIps(' 203.0.113.7, 198.51.100.9\n203.0.113.7 ')).toEqual(['203.0.113.7', '198.51.100.9'])
  })

  it('treats missing or blank configuration as no pinned addresses', () => {
    expect(parseAllowedEgressIps(undefined)).toEqual([])
    expect(parseAllowedEgressIps('   ')).toEqual([])
  })
})

describe('decideEgress', () => {
  const allowed = ['203.0.113.7']

  it('allows a pinned address', () => {
    const verdict = decideEgress({ allowed, probe: { ip: '203.0.113.7', proxyEnvVars: [] } })
    expect(verdict.decision).toBe('allowed')
    expect(verdict.detected).toBe('203.0.113.7')
  })

  it('flags an address that is not pinned', () => {
    const verdict = decideEgress({ allowed, probe: { ip: '198.51.100.9', proxyEnvVars: [] } })
    expect(verdict.decision).toBe('mismatch')
    expect(verdict.detected).toBe('198.51.100.9')
  })

  it('fails closed when the probe could not answer', () => {
    // An unreachable echo endpoint says nothing about where traffic would exit,
    // and guessing is the one thing this guard exists to avoid.
    const verdict = decideEgress({ allowed, probe: { ip: null, error: 'timed out', proxyEnvVars: [] } })
    expect(verdict.decision).toBe('unknown')
    expect(verdict.reason).toContain('timed out')
  })

  it('stays out of the way when nothing is pinned', () => {
    const verdict = decideEgress({ allowed: [], probe: { ip: '203.0.113.7', proxyEnvVars: [] } })
    expect(verdict.decision).toBe('unconfigured')
  })
})

describe('probeEgressIp', () => {
  it('returns the echoed address', async () => {
    const fetchImpl = vi.fn(async () => okResponse('203.0.113.7\n')) as unknown as typeof fetch
    const result = await probeEgressIp({ fetchImpl, url: 'https://echo.test' })
    expect(result.ip).toBe('203.0.113.7')
  })

  it('rejects a body that is not a bare IP', async () => {
    // A captive portal or a proxy error page answers 200 with HTML; treating
    // that as an address would pin the guard to garbage.
    const fetchImpl = vi.fn(async () => okResponse('<html>blocked</html>')) as unknown as typeof fetch
    const result = await probeEgressIp({ fetchImpl, url: 'https://echo.test' })
    expect(result.ip).toBeNull()
    expect(result.error).toContain('bare IP')
  })

  it('reports a non-2xx response as a failed probe instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, text: async () => '' }) as Response) as unknown as typeof fetch
    const result = await probeEgressIp({ fetchImpl, url: 'https://echo.test' })
    expect(result.ip).toBeNull()
    expect(result.error).toContain('502')
  })

  it('never throws when the request itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch

    const result = await probeEgressIp({ fetchImpl, url: 'https://echo.test' })
    expect(result.ip).toBeNull()
    expect(result.error).toContain('ENOTFOUND')
  })

  it('reports proxy env vars so the caller can say the probe may be measuring another route', async () => {
    const fetchImpl = vi.fn(async () => okResponse('203.0.113.7')) as unknown as typeof fetch
    const result = await probeEgressIp({
      fetchImpl,
      url: 'https://echo.test',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890', HTTP_PROXY: '  ' },
    })

    expect(result.proxyEnvVars).toEqual(['HTTPS_PROXY'])
  })
})

describe('confirmStartDespiteEgress', () => {
  it('starts only after the address is transcribed and then confirmed', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce('198.51.100.9')
      .mockResolvedValueOnce('yes')

    await expect(confirmStartDespiteEgress({ detected: '198.51.100.9', ask })).resolves.toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('declines when the transcription does not match, without asking again', async () => {
    // The first step is a transcription rather than a y/n on purpose: starting
    // from the wrong exit is exactly what must not happen by reflex.
    const ask = vi.fn().mockResolvedValueOnce('y')

    await expect(confirmStartDespiteEgress({ detected: '198.51.100.9', ask })).resolves.toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('declines when the second confirmation is anything but yes', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce('198.51.100.9')
      .mockResolvedValueOnce('sure')

    await expect(confirmStartDespiteEgress({ detected: '198.51.100.9', ask })).resolves.toBe(false)
  })

  it('declines when there is nobody to ask', async () => {
    // No TTY (the desktop app or a dev script spawned this): the override must
    // be unavailable rather than silently auto-answered.
    const ask = vi.fn().mockResolvedValue(null)

    await expect(confirmStartDespiteEgress({ detected: '198.51.100.9', ask })).resolves.toBe(false)
  })

  it('still requires transcription when the probe never produced an address', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('yes')

    await expect(confirmStartDespiteEgress({ detected: null, ask })).resolves.toBe(true)
  })
})
