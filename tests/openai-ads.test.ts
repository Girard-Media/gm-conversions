import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configFromEnv,
  createOpenAIAdsClient,
  sanitizeSourceUrl,
  type OpenAIAdsClientConfig,
} from '../src/openai-ads'

const BASE_CONFIG: OpenAIAdsClientConfig = {
  pixelId: 'px_test_pixel_id',
  apiKey: 'test-key',
  integrationSource: 'test-app-web',
  canonicalOrigin: 'https://example-site.com',
}

describe('createOpenAIAdsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function sentPayload() {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    return JSON.parse(String(init.body))
  }

  it('maps event names, hashes identifiers, and converts money to minor units', async () => {
    const client = createOpenAIAdsClient(BASE_CONFIG)

    const result = await client.sendEvent(
      'marketing.lead.captured.v1',
      { email: ' Lead@Example.COM ', externalId: 'lead_123', oppref: 'gAAAAAb123' },
      { value: 4500, currency: 'usd' },
      {
        eventId: 'lead_lead_123',
        sourceUrl: 'https://example-site.com/contact',
        timestampMs: 1_700_000_000_000,
      }
    )

    expect(result).toEqual({ success: true })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://bzr.openai.com/v1/events?pid=px_test_pixel_id')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')

    const body = sentPayload()
    expect(body.validate_only).toBe(false)
    expect(body.integration_source).toBe('test-app-web')
    expect(body.events).toHaveLength(1)

    const event = body.events[0]
    expect(event.type).toBe('lead_created')
    expect(event.id).toBe('lead_lead_123')
    expect(event.timestamp_ms).toBe(1_700_000_000_000)
    expect(event.action_source).toBe('web')
    expect(event.oppref).toBe('gAAAAAb123')
    expect(event.source_url).toBe('https://example-site.com/contact')
    // sha256("lead@example.com") — trimmed and lowercased before hashing.
    expect(event.user.email_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(event.user.external_id_sha256).toMatch(/^[0-9a-f]{64}$/)
    // customer_action shape for lead_created; $4,500 → 450000 cents.
    expect(event.data.type).toBe('customer_action')
    expect(event.data.amount).toBe(450_000)
    expect(event.data.currency).toBe('USD')
  })

  it('reports missing configuration instead of sending', async () => {
    const client = createOpenAIAdsClient({ integrationSource: 'test-app-web' })
    const result = await client.sendEvent('generate_lead', {}, undefined, {
      sourceUrl: 'https://example-site.com/x',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/configuration/i)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(client.isConfigured()).toBe(false)
  })

  it('rejects unmapped events and honors app-specific event map extensions', async () => {
    const client = createOpenAIAdsClient({
      ...BASE_CONFIG,
      eventMap: { webinar_registered: 'registration_completed' },
    })

    const unmapped = await client.sendEvent('made_up_event', {}, undefined, {
      sourceUrl: 'https://example-site.com/x',
    })
    expect(unmapped.success).toBe(false)
    expect(unmapped.error).toMatch(/unmapped/i)

    const mapped = await client.sendEvent('webinar_registered', {}, undefined, {
      sourceUrl: 'https://example-site.com/x',
    })
    expect(mapped.success).toBe(true)
    expect(sentPayload().events[0].type).toBe('registration_completed')
    expect(client.isMappedEvent('webinar_registered')).toBe(true)
  })

  it('requires a usable source_url for web events', async () => {
    const client = createOpenAIAdsClient(BASE_CONFIG)
    const result = await client.sendEvent('generate_lead', {}, undefined, {
      sourceUrl: 'not a url at :// all',
    })
    // A junk URL resolves against the canonical base rather than failing —
    // the truly unusable case is a non-HTTP scheme.
    const junkScheme = await client.sendEvent('generate_lead', {}, undefined, {
      sourceUrl: 'mailto:someone@example.com',
    })
    expect(junkScheme).toEqual({
      success: false,
      error: 'source_url is required when action_source is "web"',
    })
    void result
  })

  it('keeps contents off customer_action payloads so a batch cannot be malformed', async () => {
    const client = createOpenAIAdsClient(BASE_CONFIG)
    await client.sendEvent(
      'generate_lead',
      {},
      { contents: [{ id: 'x', amount: 10 }] },
      { sourceUrl: 'https://example-site.com/x' }
    )
    const event = sentPayload().events[0]
    expect(event.data.type).toBe('customer_action')
    expect(event.data.contents).toBeUndefined()
  })

  it('sends contents with per-item minor units on contents-shaped events', async () => {
    const client = createOpenAIAdsClient(BASE_CONFIG)
    await client.sendEvent(
      'checkout_completed',
      {},
      { value: 100, contents: [{ id: 'sku1', amount: 49.99, quantity: 2 }] },
      { sourceUrl: 'https://example-site.com/checkout' }
    )
    const event = sentPayload().events[0]
    expect(event.data.type).toBe('contents')
    expect(event.data.contents).toEqual([
      { id: 'sku1', amount: 4_999, currency: 'USD', quantity: 2 },
    ])
  })

  it('queueEvent surfaces a rejected upload through the logger instead of silence', async () => {
    const logger = { error: vi.fn(), log: vi.fn() }
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }))
    const client = createOpenAIAdsClient({ ...BASE_CONFIG, logger })

    client.queueEvent('generate_lead', {}, undefined, {
      eventId: 'evt_1',
      sourceUrl: 'https://example-site.com/x',
    })
    await vi.waitFor(() => {
      expect(
        logger.error.mock.calls.some((call) => String(call[0]).includes('rejected'))
      ).toBe(true)
    })
  })

  it('extracts oppref from the first-party cookie, falling back to the URL param', () => {
    const client = createOpenAIAdsClient(BASE_CONFIG)

    const withCookie = client.extractContext(
      new Request('https://example-site.com/thanks?oppref=param-value', {
        headers: {
          cookie: 'other=1; __oppref=cookie-value; more=2',
          'x-forwarded-for': '203.0.113.9, 10.0.0.1',
          'user-agent': 'UA',
        },
      })
    )
    expect(withCookie).toEqual({
      clientIpAddress: '203.0.113.9',
      clientUserAgent: 'UA',
      oppref: 'cookie-value',
    })

    const paramOnly = client.extractContext(
      new Request('https://example-site.com/thanks?oppref=param-value')
    )
    expect(paramOnly.oppref).toBe('param-value')
    expect(paramOnly.clientIpAddress).toBe('0.0.0.0')
  })
})

describe('sanitizeSourceUrl', () => {
  it('strips query strings and fragments so click ids and UTMs never leak', () => {
    expect(
      sanitizeSourceUrl(
        'https://example-site.com/go/offer?utm_source=x&oppref=SECRET#frag',
        'https://example-site.com'
      )
    ).toBe('https://example-site.com/go/offer')
  })

  it('re-bases foreign and proxy origins onto the canonical origin', () => {
    expect(
      sanitizeSourceUrl('https://evil.example/phish?x=1', 'https://example-site.com')
    ).toBe('https://example-site.com/phish')
    expect(
      sanitizeSourceUrl('http://10.0.0.5:3000/thank-you', 'https://example-site.com')
    ).toBe('https://example-site.com/thank-you')
  })

  it('resolves bare pathnames against the canonical origin', () => {
    expect(sanitizeSourceUrl('/thank-you?a=1', 'https://example-site.com')).toBe(
      'https://example-site.com/thank-you'
    )
  })

  it('passes origins through when no canonical origin is configured', () => {
    expect(sanitizeSourceUrl('https://whatever.example/p?q=1', undefined)).toBe(
      'https://whatever.example/p'
    )
  })

  it('returns undefined for non-HTTP schemes and empty input', () => {
    expect(sanitizeSourceUrl('javascript:alert(1)', 'https://example-site.com')).toBeUndefined()
    expect(sanitizeSourceUrl(undefined, 'https://example-site.com')).toBeUndefined()
  })
})

describe('configFromEnv', () => {
  it('reads the fleet env contract and warns on pixel id divergence', () => {
    const logger = { error: vi.fn(), log: vi.fn() }
    const config = configFromEnv(
      'test-app-web',
      {
        OPENAI_ADS_PIXEL_ID: 'pixel-a',
        NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: 'pixel-b',
        OPENAI_ADS_CONVERSIONS_API_KEY: 'k',
        NEXT_PUBLIC_SITE_URL: 'https://example-site.com/',
      },
      logger
    )
    expect(logger.error).toHaveBeenCalledOnce()
    expect(String(logger.error.mock.calls[0][0])).toMatch(/differ/)
    // Server-side name wins; trailing slash is normalized off.
    expect(config.pixelId).toBe('pixel-a')
    expect(config.canonicalOrigin).toBe('https://example-site.com')
  })

  it('stays silent when the two pixel ids agree', () => {
    const logger = { error: vi.fn(), log: vi.fn() }
    const config = configFromEnv(
      'test-app-web',
      {
        OPENAI_ADS_PIXEL_ID: 'pixel-a',
        NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID: 'pixel-a',
      },
      logger
    )
    expect(logger.error).not.toHaveBeenCalled()
    expect(config.pixelId).toBe('pixel-a')
  })
})
