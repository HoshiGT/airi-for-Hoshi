/**
 * Egress guard — refuses to serve Claude traffic from an unexpected exit IP.
 *
 * This bridge talks to Anthropic on the user's *subscription* login rather than
 * an API key, so where the traffic appears to come from matters to them: a
 * proxy that silently switches nodes changes the account's apparent location
 * between sessions. The guard is a deliberately boring safety interlock — check
 * the exit IP against a list the user pinned, and when it does not match, do not
 * start on its own. Starting anyway is possible but has to be done by hand.
 *
 * Everything here is pure or injectable so the policy can be unit-tested
 * without network access or a terminal.
 */

/** Bare IPv4/IPv6 shape check for whatever the echo endpoint returned. */
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,45})$/i

/** Response body cap: an IP echo answers in bytes, anything larger is not one. */
const MAX_PROBE_BODY_CHARS = 100

/**
 * Default echo endpoint. `api.ipify.org` publishes A records only, which is how
 * this reproduces `curl -4` without needing socket-family control that `fetch`
 * does not expose.
 */
export const DEFAULT_EGRESS_PROBE_URL = 'https://api.ipify.org'

/** Proxy environment variables that would route the SDK but not `fetch`. */
const PROXY_ENV_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

export interface EgressProbeResult {
  /** The detected exit IP, or `null` when the probe could not complete. */
  ip: string | null
  /** Why the probe failed, for the operator-facing log line. */
  error?: string
  /**
   * Proxy env vars present when the probe ran.
   *
   * Node's `fetch` ignores these while the Claude CLI honours them, so their
   * presence means the probe and the SDK may leave through different exits —
   * reported so the log can say so instead of implying false precision.
   */
  proxyEnvVars: string[]
}

/**
 * Splits the pinned-IP env value into a list.
 *
 * Before:
 * - "203.0.113.7, 198.51.100.9\n"
 *
 * After:
 * - ["203.0.113.7", "198.51.100.9"]
 */
export function parseAllowedEgressIps(raw: string | undefined): string[] {
  if (!raw)
    return []

  return [...new Set(raw.split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean))]
}

export type EgressDecision
  /** Detected IP is on the pinned list — start normally. */
  = | 'allowed'
  /** No list pinned — the guard cannot judge, so it stays out of the way. */
    | 'unconfigured'
  /** Probe failed. Treated as "not allowed": the guard fails closed. */
    | 'unknown'
  /** Detected IP is real and not on the list. */
    | 'mismatch'

export interface EgressVerdict {
  decision: EgressDecision
  detected: string | null
  /** Operator-facing explanation, always safe to log. */
  reason: string
}

/**
 * Turns a probe result into a start/stop verdict.
 *
 * Fails closed on an unusable probe: an offline or broken echo endpoint says
 * nothing about where traffic would exit, and the point of the guard is to not
 * guess. The manual override is the escape hatch for that case.
 */
export function decideEgress(options: { allowed: string[], probe: EgressProbeResult }): EgressVerdict {
  const { allowed, probe } = options

  if (allowed.length === 0) {
    return {
      decision: 'unconfigured',
      detected: probe.ip,
      reason: 'no pinned exit IP configured (CLAUDE_BRAIN_EGRESS_IPS)',
    }
  }

  if (!probe.ip) {
    return {
      decision: 'unknown',
      detected: null,
      reason: probe.error ? `exit IP probe failed: ${probe.error}` : 'exit IP probe failed',
    }
  }

  if (allowed.includes(probe.ip)) {
    return { decision: 'allowed', detected: probe.ip, reason: 'exit IP matches the pinned list' }
  }

  return {
    decision: 'mismatch',
    detected: probe.ip,
    reason: 'exit IP is not on the pinned list',
  }
}

/**
 * Asks an echo endpoint what the outbound IP looks like from outside.
 *
 * Never throws: a failed probe is a verdict input (`ip: null`), not an
 * exception, because the caller's job is to decide what to do about it.
 */
export async function probeEgressIp(options?: {
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}): Promise<EgressProbeResult> {
  const url = options?.url || DEFAULT_EGRESS_PROBE_URL
  const timeoutMs = options?.timeoutMs ?? 5_000
  const fetchImpl = options?.fetchImpl ?? fetch
  const env = options?.env ?? {}
  const proxyEnvVars = PROXY_ENV_VARS.filter(name => !!env[name]?.trim())

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/plain' },
      // The answer is per-request state; a cached one would defeat the check.
      cache: 'no-store',
    })

    if (!response.ok)
      return { ip: null, error: `${url} responded ${response.status}`, proxyEnvVars }

    const body = (await response.text()).slice(0, MAX_PROBE_BODY_CHARS).trim()
    if (!IP_PATTERN.test(body))
      return { ip: null, error: `${url} did not return a bare IP`, proxyEnvVars }

    return { ip: body, proxyEnvVars }
  }
  catch (error) {
    // `String(error)` rather than `@moeru/std`'s errorMessageFrom: this service
    // deliberately keeps a four-dependency footprint, and the value is only ever
    // a log line. It reads "Error: getaddrinfo ENOTFOUND ..." — fine for that.
    return { ip: null, error: String(error), proxyEnvVars }
  }
}

/**
 * Two-step manual override, for starting anyway after a mismatch or a failed
 * probe.
 *
 * Two steps on purpose, and the first one is a transcription rather than a
 * y/n: the whole guard exists because starting on the wrong exit is the thing
 * the user wants to never do by reflex, and typing the address out is the
 * cheapest way to make the confirmation deliberate. A single keystroke would
 * defeat it.
 *
 * `ask` is injected (and returns `null` when input is unavailable) so the flow
 * is testable and so a non-interactive launch — the app spawning this bridge
 * with no terminal attached — can only decline.
 */
export async function confirmStartDespiteEgress(options: {
  detected: string | null
  ask: (question: string) => Promise<string | null>
}): Promise<boolean> {
  const { detected, ask } = options

  const expectedAnswer = detected ?? 'unknown'
  const first = await ask(`Type the detected exit IP (${expectedAnswer}) to continue, anything else aborts: `)
  if (first?.trim() !== expectedAnswer)
    return false

  const second = await ask('Start claude-code-brain from this exit anyway? Type "yes" to confirm: ')
  return second?.trim().toLowerCase() === 'yes'
}
