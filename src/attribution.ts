// First-party marketing attribution capture. On every marketing page view we
// look for UTM parameters and ad-platform click IDs in the URL; when present
// they're persisted to localStorage (with a cookie mirror so server-side CAPI
// can read click IDs later). First touch is written once per visitor; last
// touch is refreshed whenever a new tagged visit lands. Lead forms attach
// getLeadAttribution() to their payloads so every lead carries the campaign
// and click ID that produced it — required for Google Ads offline-conversion
// import and cross-platform ROAS reporting.

export interface AttributionParams {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmTerm?: string
  utmContent?: string
  gclid?: string
  gbraid?: string
  wbraid?: string
  fbclid?: string
  msclkid?: string
  ttclid?: string
  liFatId?: string
  /** OpenAI Ads (ChatGPT ads) click identifier. */
  oppref?: string
}

export interface AttributionTouch extends AttributionParams {
  landingPage?: string
  referrer?: string
  at?: string
}

interface StoredAttribution {
  first?: AttributionTouch
  last?: AttributionTouch
}

const STORAGE_KEY = 'gm_attribution'
const COOKIE_NAME = 'gm_attr'
const COOKIE_MAX_AGE_DAYS = 90

// URL param → payload key. Order matters only for readability.
const PARAM_MAP: Record<string, keyof AttributionParams> = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_term: 'utmTerm',
  utm_content: 'utmContent',
  gclid: 'gclid',
  gbraid: 'gbraid',
  wbraid: 'wbraid',
  fbclid: 'fbclid',
  msclkid: 'msclkid',
  ttclid: 'ttclid',
  li_fat_id: 'liFatId',
  oppref: 'oppref',
}

/**
 * Per-param length caps. `oppref` is an opaque OpenAI token that runs longer
 * than the other click IDs, and a truncated one is worse than none: it silently
 * fails to match instead of erroring.
 */
const PARAM_MAX_LENGTH: Partial<Record<keyof AttributionParams, number>> = {
  oppref: 1024,
}
const DEFAULT_PARAM_MAX_LENGTH = 256

function readStored(): StoredAttribution {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredAttribution) : {}
  } catch {
    return {}
  }
}

function writeStored(value: StoredAttribution) {
  try {
    const json = JSON.stringify(value)
    window.localStorage.setItem(STORAGE_KEY, json)
    // Cookie mirror (last touch only, compact) so API routes can read click
    // IDs for server-side conversion uploads without a client round trip.
    const compact = JSON.stringify(value.last ?? {})
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(compact)}; path=/; max-age=${
      COOKIE_MAX_AGE_DAYS * 24 * 60 * 60
    }; SameSite=Lax`
  } catch {
    // Storage unavailable (private mode / blocked) — attribution degrades
    // gracefully to whatever is in the current URL at submit time.
  }
}

function parseParams(search: string): AttributionParams {
  const params = new URLSearchParams(search)
  const out: AttributionParams = {}
  for (const [param, key] of Object.entries(PARAM_MAP)) {
    const value = params.get(param)
    if (value) out[key] = value.slice(0, PARAM_MAX_LENGTH[key] ?? DEFAULT_PARAM_MAX_LENGTH)
  }
  return out
}

/**
 * Capture attribution from the current URL. Call on every marketing page
 * navigation; it's a no-op unless the URL carries tagged params (except the
 * very first visit, which always records landing page + referrer).
 */
export function captureAttribution() {
  if (typeof window === 'undefined') return

  const params = parseParams(window.location.search)
  const hasParams = Object.keys(params).length > 0
  const stored = readStored()

  if (!stored.first) {
    stored.first = {
      ...params,
      landingPage: window.location.pathname + window.location.search,
      referrer: document.referrer || undefined,
      at: new Date().toISOString(),
    }
    stored.last = stored.first
    writeStored(stored)
    return
  }

  if (hasParams) {
    stored.last = {
      ...params,
      landingPage: window.location.pathname + window.location.search,
      referrer: document.referrer || undefined,
      at: new Date().toISOString(),
    }
    writeStored(stored)
  }
}

/**
 * Flattened attribution for lead form payloads: last-touch campaign params +
 * click IDs, with the original landing page/referrer from the first touch.
 * Falls back to the current URL when storage is empty or blocked.
 */
export function getLeadAttribution(): AttributionTouch {
  if (typeof window === 'undefined') return {}

  const stored = readStored()
  const current = parseParams(window.location.search)
  const last = stored.last ?? {}

  const merged: AttributionTouch = {
    ...last,
    // Params in the current URL always win — the visitor may have arrived
    // from a newer ad click than the stored touch.
    ...current,
    landingPage:
      stored.first?.landingPage ?? window.location.pathname + window.location.search,
    referrer: stored.first?.referrer ?? document.referrer ?? undefined,
  }
  delete merged.at

  // Drop empty keys so payloads stay compact and zod optionals stay absent.
  return Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v != null && v !== '')
  ) as AttributionTouch
}
