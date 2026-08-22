# gm-conversions

Shared first-party attribution capture + OpenAI Ads (ChatGPT ads) pixel and
Conversions API for Girard Media fleet apps. One implementation, consumed by
every site, so measurement can never silently drift between repos — a
measurement bug that exists in only one repo is invisible until budget has
been mis-spent.

Extracted 2026-08-22 from girard-media (the reference implementation, which
passes all ten checks of OpenAI's official verifiers) as part of the
girard-media ↔ agency-script tech exchange.

## Modules

| Import | What it is | Runs where |
|---|---|---|
| `gm-conversions/attribution` | UTM + click-id capture (`gclid`, `fbclid`, `ttclid`, `oppref`, …) into localStorage with a cookie mirror; `getLeadAttribution()` for lead-form payloads | Browser |
| `gm-conversions/react` | `<AttributionTracker>` (mount once in the marketing layout), `<OpenAIAdsPixel>`, `trackOpenAIAdsEvent()` | Browser (Next.js) |
| `gm-conversions/openai-ads` | `createOpenAIAdsClient()` — server-side Conversions API sender with hashing, minor-unit money, event mapping, `source_url` sanitization, `oppref` extraction | Server |

## Design rule: no import-time binding

Nothing in this package reads `process.env` at module load (the browser pixel
component's default prop is the one JSX-idiomatic exception — pass `pixelId`
explicitly to avoid even that). Config is captured when you create the client.
This is deliberate: the fleet's Resend integration once bound its base URL at
import time and silently 401'd a valid key because dotenv ran after import.
Do not "improve" this back into module-level constants.

## Server usage

```ts
// lib/openai-ads.ts (per app — the ONLY app-specific code needed)
import { createOpenAIAdsClient, configFromEnv } from 'gm-conversions/openai-ads'

export function getOpenAIAdsClient() {
  return createOpenAIAdsClient({
    ...configFromEnv('my-app-web'), // integration_source identifies the app
    eventMap: { webinar_registered: 'registration_completed' }, // app extras
  })
}
```

```ts
// In an API route / server action, after the conversion happens:
const client = getOpenAIAdsClient()
const ctx = client.extractContext(request) // oppref cookie/param, IP, UA
client.queueEvent(
  'generate_lead',
  { email, externalId: leadId, ...ctx },
  { value: 4500, currency: 'USD' },
  { eventId: `lead_${leadId}`, sourceUrl: request.headers.get('referer') ?? undefined }
)
```

`queueEvent` is fire-and-forget but never silent: a rejected upload logs an
error (a rejected upload *resolves* `{success:false}` rather than throwing, so
a bare `.catch()` would hide it and the spend would go unattributed).

## Browser usage

```tsx
// app/(marketing)/layout.tsx
import { AttributionTracker, OpenAIAdsPixel } from 'gm-conversions/react'
// ...
<AttributionTracker />
<OpenAIAdsPixel />
```

```ts
// In a lead form submit handler:
import { getLeadAttribution } from 'gm-conversions/attribution'
import { trackOpenAIAdsEvent } from 'gm-conversions/react'

const payload = { ...form, attribution: getLeadAttribution() }
// Same eventId as the server-side send, so OpenAI dedupes the pair:
trackOpenAIAdsEvent('generate_lead', { type: 'customer_action' }, eventId)
```

## Env contract (per app)

```
NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID=  # browser pixel
OPENAI_ADS_PIXEL_ID=              # server; MUST equal the NEXT_PUBLIC value
OPENAI_ADS_CONVERSIONS_API_KEY=   # server-only, from Ads Manager > Manage conversion keys
NEXT_PUBLIC_SITE_URL=             # canonical origin source_url is re-based onto
OPENAI_ADS_VALIDATE_ONLY=         # "true" = validation path only; never in prod
```

## The two traps (learned the hard way, both caught by OpenAI's verifiers)

1. **Same pixel id on both sides.** OpenAI dedupes a pixel/CAPI event pair by
   `(pixel id, event id)`. If `OPENAI_ADS_PIXEL_ID` and
   `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` diverge, nothing dedupes and every
   double-sent conversion counts twice. `configFromEnv` logs an error on
   divergence; nothing upstream enforces it.
2. **Sanitize `source_url`.** Referers and `request.url` carry query strings
   (UTMs, `oppref`) and proxy/attacker-controllable origins.
   `createOpenAIAdsClient` sanitizes at the boundary — origin + pathname only,
   re-based onto the canonical origin — so no caller can leak by accident.

NEXT_PUBLIC build note: `NEXT_PUBLIC_*` values are inlined at **build** time.
On hostssh, that means they must be present as build args when the image is
built, not just in the runtime env file.

## Release gate

After any change here, and after wiring a new consumer, run OpenAI's official
verifiers against the consuming repo (stdlib-only, no network, no writes):

```
scripts/verify_ads_setup.py <repo> --require pixel --require capi --require dedupe \
  --require shared-pixel-id --require oppref --require source-url
scripts/verify_capi_secret_not_exposed.py <repo>
```

Source: `https://raw.githubusercontent.com/openai/plugins/main/plugins/openai-ads-conversions/skills/openai-ads-conversions-setup/scripts/`
A non-empty `failed_required` is a blocker.

## Consuming from an app

Both consumers are plain (non-workspace) pnpm/npm projects, so link by path
during development and pin by git once this repo has a remote:

```jsonc
// package.json (dev)
"gm-conversions": "file:../gm-conversions"
// package.json (pinned, once a remote exists)
"gm-conversions": "git+<remote-url>#<tag>"
```

The hub build clones only the app repo, so a `file:` dependency will NOT
resolve on `.223` — cut over to the git pin before deploying a consumer.

## Migration notes (girard-media)

girard-media's `lib/openai-ads-events-api.ts`, `lib/openai-ads-conversion-tracking.ts`,
`lib/marketing/attribution.ts`, `components/openai-ads-pixel.tsx` and
`components/marketing/attribution-tracker.tsx` are the origin of this code and
stay authoritative until the cutover lands there. Behavior differences in the
package version, all deliberate:

- Factory config instead of import-time env binding (see design rule above).
- `integration_source` is a required config value, not a hardcoded constant.
- The app-specific event map extends `DEFAULT_EVENT_MAP` via config.
- `sanitizeSourceUrl(candidate, canonicalOrigin)` takes the origin as an
  argument instead of reading `NEXT_PUBLIC_SITE_URL` internally.
