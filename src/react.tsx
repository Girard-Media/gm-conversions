'use client'

import { useEffect } from 'react'
import Script from 'next/script'
import { usePathname } from 'next/navigation'
import { captureAttribution } from './attribution'

// Records UTM params + ad click IDs (gclid/fbclid/ttclid/oppref/…) into
// first-party storage on every marketing page view so lead forms can attach
// attribution. Mount once in the marketing layout; renders nothing.
export function AttributionTracker() {
  const pathname = usePathname()

  useEffect(() => {
    captureAttribution()
  }, [pathname])

  return null
}

/**
 * OpenAI Ads (ChatGPT ads) Measurement Pixel.
 *
 * The SDK captures the `oppref` click identifier from the landing URL and
 * stores it in a first-party `__oppref` cookie, which is what lets the
 * server-side Conversions API attribute conversions back to an ad click.
 *
 * The stub, init and SDK <script> injection live in one inline block on
 * purpose. Two separate <Script> tags are not guaranteed to execute in order,
 * and if the SDK ran first the stub would overwrite the real `oaiq` with the
 * queue shim and silently drop every event.
 *
 * `pixelId` must be the same pixel the server-side Conversions API sends with,
 * or dedupe cannot match and every double-sent conversion counts twice. Pass
 * it from NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID (the default when omitted).
 *
 * Docs: https://developers.openai.com/ads/measurement-pixel
 */
export function OpenAIAdsPixel({
  pixelId = process.env.NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID,
  nonce,
}: {
  pixelId?: string
  nonce?: string
}) {
  if (!pixelId) return null

  return (
    <Script
      id="openai-ads-pixel"
      strategy="afterInteractive"
      nonce={nonce}
      dangerouslySetInnerHTML={{
        __html: `
          !function (w, d) {
            if (w.oaiq) return;
            w.oaiq = function () { (w.oaiq.q = w.oaiq.q || []).push(arguments) };
            w.oaiq("init", { pixelId: ${JSON.stringify(pixelId)} });
            w.oaiq("measure", "page_viewed", { type: "contents" });
            var s = d.createElement("script");
            s.async = !0;
            s.src = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
            var f = d.getElementsByTagName("script")[0];
            f.parentNode.insertBefore(s, f);
          }(window, document);
        `,
      }}
    />
  )
}

/**
 * Send an OpenAI Ads conversion event from the browser.
 *
 * Pass the same `eventId` here as the event `id` sent to the Conversions API so
 * OpenAI dedupes the pair instead of counting the conversion twice.
 */
export function trackOpenAIAdsEvent(
  eventName: string,
  data: Record<string, unknown> = { type: 'contents' },
  eventId?: string
) {
  if (typeof window !== 'undefined' && typeof window.oaiq === 'function') {
    if (eventId) {
      window.oaiq('measure', eventName, data, { event_id: eventId })
    } else {
      window.oaiq('measure', eventName, data)
    }
  }
}

declare global {
  interface Window {
    oaiq: {
      (command: 'init', options: { pixelId: string; debug?: boolean; user?: Record<string, unknown> }): void
      (command: 'consent', granted: boolean): void
      (
        command: 'measure',
        eventName: string,
        data: Record<string, unknown>,
        options?: { event_id?: string; custom_event_name?: string; opt_out?: boolean }
      ): void
      q?: IArguments[]
    }
  }
}
