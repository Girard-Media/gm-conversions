/**
 * OpenAI Ads Conversions API — Server-Side Event Sender (shared fleet package)
 *
 * Sends conversion events directly from the server to OpenAI Ads (ChatGPT ads),
 * bypassing ad blockers and improving match quality. Mirrors the browser
 * <OpenAIAdsPixel> so the same conversion can be sent from both sides: OpenAI
 * deduplicates when the API `id` equals the pixel `event_id` for the same pixel.
 *
 * Unlike the app-local original this module binds NOTHING at import time —
 * config is read when the client is created (or per call via `fromEnv`), so
 * loading order can never silently misconfigure it. That failure mode is real:
 * the fleet's Resend integration once bound its base URL at module load and
 * 401'd a valid key because dotenv ran after import.
 *
 * Docs: https://developers.openai.com/ads/conversions-api
 */

import { createHash } from 'crypto'

const ENDPOINT = 'https://bzr.openai.com/v1/events'

/** First-party cookie the browser pixel writes the click identifier into. */
export const OPPREF_COOKIE = '__oppref'

// ─── Types ───────────────────────────────────────────────────────────────────

/** Standard event types accepted by the Conversions API. */
export type OpenAIAdsEventType =
  | 'appointment_scheduled'
  | 'checkout_started'
  | 'contents_viewed'
  | 'items_added'
  | 'lead_created'
  | 'order_created'
  | 'page_viewed'
  | 'registration_completed'
  | 'subscription_created'
  | 'trial_started'
  | 'app_installed'
  | 'app_opened'

type DataType = 'contents' | 'customer_action' | 'plan_enrollment' | 'custom'

type ActionSource = 'web' | 'mobile_app' | 'offline' | 'physical_store' | 'phone_call' | 'email' | 'other'

export interface OpenAIAdsUserData {
  /**
   * Deliberately no `phone`: OpenAI documents that raw phone numbers AND phone
   * hashes must not be sent. Callers pass phone to Meta/TikTok, not here.
   */
  email?: string
  externalId?: string
  country?: string
  city?: string
  zip?: string
  clientIpAddress?: string
  clientUserAgent?: string
  /** Opaque OpenAI click identifier. Passed through unmodified. */
  oppref?: string
}

export interface OpenAIAdsContentItem {
  id?: string
  groupId?: string
  name?: string
  contentType?: string
  quantity?: number
  /** Major currency units (e.g. dollars) — converted to minor units on send. */
  amount?: number
  currency?: string
}

export interface OpenAIAdsEventData {
  /** Defaults to the shape that matches the event type (see DEFAULT_DATA_TYPE). */
  dataType?: DataType
  /** Major currency units (e.g. 4500 = $4,500.00) — converted to minor units. */
  value?: number
  currency?: string
  contents?: OpenAIAdsContentItem[]
  planId?: string
}

export interface OpenAIAdsClientConfig {
  /** The pixel id. Must equal the browser pixel's id or dedupe silently double-counts. */
  pixelId?: string
  /** Key from Ads Manager > Manage conversion keys. Server-only; never NEXT_PUBLIC. */
  apiKey?: string
  /** Identifies the sending app in payloads, e.g. "girard-media-web". */
  integrationSource: string
  /**
   * Canonical public origin (e.g. "https://girardmedia.com") that source_url is
   * re-based onto. Unset = origins are passed through (dev), never rewritten to
   * a wrong default.
   */
  canonicalOrigin?: string
  /** Send events to the validation path only — nothing is counted. Never in prod. */
  validateOnly?: boolean
  /**
   * App-specific internal event name → OpenAI standard event type, merged over
   * the shared defaults. Page views are intentionally absent from the defaults:
   * the browser pixel already sends `page_viewed`, and a server copy carries a
   * different event id so nothing dedupes — every page view counts twice.
   */
  eventMap?: Record<string, OpenAIAdsEventType>
  /** Defaults to console. Injected so app loggers can own the output. */
  logger?: Pick<Console, 'error' | 'log'>
  /** Dev-style verbose logging of sends/skips. */
  debug?: boolean
}

/**
 * Shared internal event name → OpenAI standard event type. Only conversions
 * worth optimizing toward belong here.
 */
export const DEFAULT_EVENT_MAP: Record<string, OpenAIAdsEventType> = {
  generate_lead: 'lead_created',
  contact_form: 'lead_created',
  sign_up: 'registration_completed',
  checkout_started: 'checkout_started',
  checkout_completed: 'order_created',
  booking_completed: 'appointment_scheduled',
  plan_viewed: 'contents_viewed',
  // Unified event taxonomy mappings
  'marketing.lead.captured.v1': 'lead_created',
  'shop.checkout.started.v1': 'checkout_started',
  'shop.checkout.completed.v1': 'order_created',
}

/** Data shape each event type is sent with unless the caller overrides it. */
const DEFAULT_DATA_TYPE: Record<OpenAIAdsEventType, DataType> = {
  appointment_scheduled: 'customer_action',
  lead_created: 'customer_action',
  registration_completed: 'customer_action',
  app_installed: 'customer_action',
  app_opened: 'customer_action',
  checkout_started: 'contents',
  contents_viewed: 'contents',
  items_added: 'contents',
  order_created: 'contents',
  page_viewed: 'contents',
  subscription_created: 'plan_enrollment',
  trial_started: 'plan_enrollment',
}

// ─── Hashing & money ─────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

/**
 * Currencies with no minor unit. Everything else is assumed to have two
 * decimals, which covers every currency the fleet transacts in. Getting this
 * wrong overstates revenue by 100x, so the exceptions are listed explicitly.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

/** Convert major units (dollars) to the minor units the API expects (cents). */
function toMinorUnits(value: number, currency: string): number {
  const factor = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100
  return Math.round(value * factor)
}

// ─── source_url ──────────────────────────────────────────────────────────────

/**
 * Reduce a candidate URL to the `origin + pathname` form the API expects.
 *
 * Three things this must not do, each of which a naive `referer` or
 * `request.url` pass-through would do by default:
 *
 *  - **Leak the query string.** Ad landing pages carry UTMs and the `oppref`
 *    click id, and form referers can carry arbitrary caller-supplied params.
 *    None of it belongs in a conversion payload, so query and fragment are
 *    dropped rather than forwarded.
 *  - **Report a proxy origin.** Behind a reverse proxy, `request.url` is an
 *    internal origin, not the public site. The path is kept but re-based onto
 *    the canonical public origin.
 *  - **Trust a browser-supplied origin.** `referer` is attacker-controllable,
 *    so an origin that is not ours is discarded, keeping only the pathname.
 *
 * Returns undefined when there is nothing usable (non-HTTP(S) scheme,
 * unparseable), which makes a `web` event fail its required-field check
 * instead of sending junk.
 */
export function sanitizeSourceUrl(
  candidate: string | undefined,
  canonicalOrigin?: string
): string | undefined {
  if (!candidate) return undefined

  const base = canonicalOrigin?.replace(/\/+$/, '') || 'http://localhost:3000'

  let parsed: URL
  try {
    // The base makes a bare pathname ("/thank-you") resolvable.
    parsed = new URL(candidate, `${base}/`)
  } catch {
    return undefined
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined

  // Only pin to the canonical origin when one is actually CONFIGURED —
  // re-basing onto a default would rewrite every genuine production URL,
  // trading a query-string leak for a wholly wrong source_url.
  if (!canonicalOrigin) return `${parsed.origin}${parsed.pathname}`

  let pinned: string
  try {
    pinned = new URL(base).origin
  } catch {
    pinned = parsed.origin
  }

  const origin = parsed.origin === pinned ? parsed.origin : pinned
  return `${origin}${parsed.pathname}`
}

// ─── Env loading ─────────────────────────────────────────────────────────────

/**
 * Build config from the fleet-standard env contract. Called by apps at client
 * creation, NOT at module load.
 *
 * OPENAI_ADS_PIXEL_ID and NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID are the SAME logical
 * pixel id — the server-only name simply lets the browser pixel stay off while
 * CAPI still reports. They must hold an identical value: OpenAI dedupes a
 * pixel/CAPI pair by (pixel id, event id), so two different pixels means
 * nothing dedupes and every conversion is counted twice. Nothing upstream
 * enforces that, so divergence is reported here rather than left silent.
 */
export function configFromEnv(
  integrationSource: string,
  env: Record<string, string | undefined> = process.env,
  logger: Pick<Console, 'error' | 'log'> = console
): OpenAIAdsClientConfig {
  if (
    env.OPENAI_ADS_PIXEL_ID &&
    env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID &&
    env.OPENAI_ADS_PIXEL_ID !== env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID
  ) {
    logger.error(
      '[OpenAI Ads] OPENAI_ADS_PIXEL_ID and NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID differ. ' +
        'They must be the same pixel id or pixel/CAPI deduplication cannot match, ' +
        'which double-counts every conversion sent from both sides.'
    )
  }

  return {
    pixelId: env.OPENAI_ADS_PIXEL_ID || env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID,
    apiKey: env.OPENAI_ADS_CONVERSIONS_API_KEY,
    integrationSource,
    canonicalOrigin: (env.NEXT_PUBLIC_SITE_URL || env.NEXT_PUBLIC_APP_URL)?.replace(/\/+$/, ''),
    validateOnly: env.OPENAI_ADS_VALIDATE_ONLY === 'true',
    debug: env.NODE_ENV === 'development',
    logger,
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface OpenAIAdsClient {
  isConfigured(): boolean
  isMappedEvent(eventName: string): boolean
  sendEvent(
    eventName: string,
    userData: OpenAIAdsUserData,
    data?: OpenAIAdsEventData,
    options?: { eventId?: string; sourceUrl?: string; actionSource?: ActionSource; timestampMs?: number }
  ): Promise<{ success: boolean; error?: string }>
  /**
   * Fire-and-forget send that still reports rejection honestly: a rejected
   * upload resolves `{success:false}` rather than throwing, so a bare
   * `.catch()` would report nothing and the spend would go unattributed
   * silently.
   */
  queueEvent(
    eventName: string,
    userData: OpenAIAdsUserData,
    data?: OpenAIAdsEventData,
    options?: { eventId?: string; sourceUrl?: string; actionSource?: ActionSource; timestampMs?: number }
  ): void
  /** Extract the click identifier and client info from an incoming Request. */
  extractContext(request: Request): {
    clientIpAddress: string
    clientUserAgent: string
    oppref?: string
  }
}

export function createOpenAIAdsClient(config: OpenAIAdsClientConfig): OpenAIAdsClient {
  const log = config.logger ?? console
  const eventMap: Record<string, OpenAIAdsEventType> = {
    ...DEFAULT_EVENT_MAP,
    ...config.eventMap,
  }

  async function sendEvent(
    eventName: string,
    userData: OpenAIAdsUserData,
    data?: OpenAIAdsEventData,
    options?: { eventId?: string; sourceUrl?: string; actionSource?: ActionSource; timestampMs?: number }
  ): Promise<{ success: boolean; error?: string }> {
    if (!config.pixelId || !config.apiKey) {
      if (config.debug) {
        log.log('[OpenAI Ads] Skipped — missing pixelId or Conversions API key')
      }
      return { success: false, error: 'Missing OpenAI Ads Conversions API configuration' }
    }

    const eventType = eventMap[eventName]
    if (!eventType) {
      return { success: false, error: `Unmapped OpenAI Ads event: ${eventName}` }
    }

    const actionSource: ActionSource = options?.actionSource ?? 'web'
    // Sanitized here, at the boundary, rather than trusting each caller: every
    // path into this function gets query strings, fragments and proxy/untrusted
    // origins stripped, and one careless `referer` pass-through cannot leak.
    const sourceUrl = sanitizeSourceUrl(options?.sourceUrl, config.canonicalOrigin)
    if (actionSource === 'web' && !sourceUrl) {
      return { success: false, error: 'source_url is required when action_source is "web"' }
    }

    const user: Record<string, unknown> = {}
    if (userData.email) user.email_sha256 = sha256(userData.email)
    if (userData.externalId) user.external_id_sha256 = sha256(userData.externalId)
    if (userData.country) user.country = userData.country.trim().toUpperCase().slice(0, 2)
    if (userData.city) user.city = userData.city.slice(0, 128)
    if (userData.zip) user.zip_code = userData.zip.slice(0, 32)
    if (userData.clientIpAddress) user.ip_address = userData.clientIpAddress
    if (userData.clientUserAgent) user.user_agent = userData.clientUserAgent

    const currency = (data?.currency || 'USD').toUpperCase()
    const dataType = data?.dataType ?? DEFAULT_DATA_TYPE[eventType]
    const eventData: Record<string, unknown> = { type: dataType }
    if (data?.value != null && Number.isFinite(data.value)) {
      eventData.amount = toMinorUnits(data.value, currency)
      // `currency` is required whenever `amount` is present.
      eventData.currency = currency
    }
    // `plan_id` and `contents` only belong on the data shapes that define them —
    // a `customer_action` payload carrying `contents` is a malformed event, and a
    // rejected batch takes every event in it down.
    if (data?.planId && (dataType === 'plan_enrollment' || dataType === 'custom')) {
      eventData.plan_id = data.planId
    }
    if (data?.contents?.length && (dataType === 'contents' || dataType === 'custom')) {
      eventData.contents = data.contents.map((item) => {
        const itemCurrency = (item.currency || currency).toUpperCase()
        const entry: Record<string, unknown> = {}
        if (item.id) entry.id = item.id
        if (item.groupId) entry.group_id = item.groupId
        if (item.name) entry.name = item.name
        if (item.contentType) entry.content_type = item.contentType
        if (item.quantity != null) entry.quantity = item.quantity
        if (item.amount != null && Number.isFinite(item.amount)) {
          entry.amount = toMinorUnits(item.amount, itemCurrency)
          entry.currency = itemCurrency
        }
        return entry
      })
    }

    const event: Record<string, unknown> = {
      id: options?.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      type: eventType,
      timestamp_ms: options?.timestampMs ?? Date.now(),
      action_source: actionSource,
      data: eventData,
    }
    if (sourceUrl) event.source_url = sourceUrl
    // Opaque attribution context — pass through byte-for-byte, never parsed or logged.
    if (userData.oppref) event.oppref = userData.oppref
    if (Object.keys(user).length > 0) event.user = user

    try {
      const res = await fetch(`${ENDPOINT}?pid=${encodeURIComponent(config.pixelId)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          validate_only: Boolean(config.validateOnly),
          integration_source: config.integrationSource,
          events: [event],
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        log.error('[OpenAI Ads] Error:', res.status, body)
        return { success: false, error: `HTTP ${res.status}: ${body}` }
      }

      if (config.debug) {
        log.log('[OpenAI Ads] Sent:', eventType, await res.text())
      }

      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      log.error('[OpenAI Ads] Fetch failed:', message)
      return { success: false, error: message }
    }
  }

  return {
    isConfigured: () => Boolean(config.pixelId && config.apiKey),
    isMappedEvent: (eventName) => eventName in eventMap,
    sendEvent,
    queueEvent(eventName, userData, data, options) {
      sendEvent(eventName, userData, data, options)
        .then((result) => {
          if (!result?.success) {
            log.error(
              `OpenAI Ads conversion rejected (${eventName}, event_id=${options?.eventId ?? 'none'}): ${result?.error ?? 'unknown error'}`
            )
          }
        })
        .catch((error) => {
          log.error('OpenAI Ads conversion dispatch failed:', error)
        })
    },
    extractContext(request) {
      const cookies = request.headers.get('cookie') || ''
      // Raw cookie value: not decoded or normalized, per OpenAI's guidance.
      const cookieOppref = cookies.match(/(?:^|;\s*)__oppref=([^;]+)/)?.[1]

      let paramOppref: string | undefined
      try {
        paramOppref = new URL(request.url).searchParams.get('oppref') || undefined
      } catch {
        paramOppref = undefined
      }

      return {
        clientIpAddress:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          request.headers.get('x-real-ip') ||
          '0.0.0.0',
        clientUserAgent: request.headers.get('user-agent') || '',
        oppref: cookieOppref || paramOppref,
      }
    },
  }
}
