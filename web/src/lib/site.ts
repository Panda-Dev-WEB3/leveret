/**
 * Site-wide configuration — the single source of truth for SEO.
 *
 * Consumed by the metadata generator, `robots.ts`, `sitemap.ts`, and the
 * JSON-LD structured-data helper.
 *
 * Every string here is the site's own copy, not invented for the meta tags:
 * the name and wordmark come from the hero (node 854:950), the tagline from the
 * hero title (854:953 / 854:954), and the description is assembled from block
 * 3's asides and block 4's "Local Experiences" panel. Changing the copy in
 * `src/data/mocks/home.ts` and leaving this file alone would put the share card
 * out of step with the page, so the two are meant to be edited together.
 */
import { publicEnv } from "@/env";

export const siteConfig = {
  name: "WanderLust",
  /** Hero title, run together as one line for `<title>` and share cards. */
  tagline: "Beyond Places. Into Moments.",
  description:
    "Journeys to sixteen countries, planned around the moments you'll still talk about years later. We meet local people, try real food, and find the places that don't make it to the guidebooks.",
  /**
   * Public origin, no trailing slash. Drives canonical URLs, OG tags, the
   * sitemap, and JSON-LD. Set `NEXT_PUBLIC_SITE_URL` in production.
   */
  url: publicEnv.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  /**
   * Default Open Graph / Twitter share image (path under `public/`).
   *
   * The JPEG rather than the PNG beside it: both are the same 1200×630 render,
   * but WhatsApp drops a link preview whose image is over ~300KB, and the
   * photograph costs 900KB as a PNG against 90KB here. `open-graph.png` is kept
   * as the lossless master.
   */
  ogImage: "/open-graph.jpg",
  ogImageAlt:
    "WanderLust — a traveller above a glacial river valley, with the words Beyond Places. Into Moments.",
  twitterHandle: "@wanderlust",
  author: "WanderLust",
  /** Browser theme-color: the hero's black, which is what loads first. */
  themeColor: "#000000",
} as const;
