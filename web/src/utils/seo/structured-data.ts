/**
 * @fileoverview JSON-LD structured data helpers.
 *
 * Structured data lets search engines understand the site as entities
 * (Organization, WebSite) rather than just text — improving rich results.
 * Render the output inside a `<script type="application/ld+json">` tag.
 */

import { siteConfig } from "@/lib/site";

/**
 * Organization + WebSite schema for the site root. Emit once, in the root
 * layout. The two nodes are linked by `@id` so crawlers treat them as related.
 *
 * The organization is typed `TravelAgency` rather than the bare `Organization`:
 * it is a subtype, so nothing is lost, and it is what the site actually is —
 * block 5 sells journey planning, not a product catalogue.
 *
 * `sameAs` is deliberately absent. It lists an entity's own social profiles, and
 * the three marks in block 5's footer still point at `#` — a `sameAs` of
 * placeholder URLs is worse than none. Add it here once the accounts are real.
 */
export function getSiteStructuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TravelAgency",
        "@id": `${siteConfig.url}/#organization`,
        name: siteConfig.name,
        description: siteConfig.description,
        url: siteConfig.url,
        logo: {
          "@type": "ImageObject",
          url: `${siteConfig.url}/icon-512x512.png`,
          width: 512,
          height: 512,
        },
        image: `${siteConfig.url}${siteConfig.ogImage}`,
      },
      {
        "@type": "WebSite",
        "@id": `${siteConfig.url}/#website`,
        name: siteConfig.name,
        description: siteConfig.description,
        url: siteConfig.url,
        inLanguage: "en",
        publisher: { "@id": `${siteConfig.url}/#organization` },
      },
    ],
  };
}
