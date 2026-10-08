/**
 * @fileoverview Standardised metadata + viewport generators for pages.
 *
 * `generateMetadata` builds a Next.js `Metadata` object — basic meta tags,
 * OpenGraph, Twitter cards, canonical URL, icons, robots. `metadataBase` is
 * always set (from `siteConfig`) so relative URLs (OG image, canonical)
 * resolve to absolute — required by social scrapers.
 *
 * `generateViewport` builds the `Viewport` export. `themeColor` lives here, not
 * in `Metadata` — Next deprecated it on the metadata object.
 */

import { Metadata, Viewport } from "next";

import { siteConfig } from "@/lib/site";

interface MetadataProps {
  title?: string;
  description?: string;
  /** Canonical path (e.g. `/about`) or absolute URL for this page. */
  url?: string;
  /** Open Graph / Twitter image — path under `public/` or absolute URL. */
  ogImage?: string;
  twitterHandle?: string;
  author?: string;
  siteName?: string;
}

/**
 * The home page's title, and the pattern every other page takes.
 *
 * A page that passes a `title` gets "Iceland — WanderLust" through the
 * template; the root, which passes nothing, gets the brand and the hero's own
 * tagline instead of the bare name twice over.
 */
const HOME_TITLE = `${siteConfig.name} — ${siteConfig.tagline}`;

export function generateMetadata({
  title,
  description = siteConfig.description,
  url = "/",
  ogImage = siteConfig.ogImage,
  twitterHandle = siteConfig.twitterHandle,
  author = siteConfig.author,
  siteName = siteConfig.name,
}: MetadataProps = {}): Metadata {
  /* The share cards take one resolved string: OG and Twitter have no template
     mechanism of their own, so the pattern has to be applied here. */
  const shareTitle = title ? `${title} — ${siteConfig.name}` : HOME_TITLE;

  return {
    // Resolves every relative URL below to an absolute one.
    metadataBase: new URL(siteConfig.url),
    title: title
      ? { default: title, template: `%s — ${siteConfig.name}` }
      : { default: HOME_TITLE, template: `%s — ${siteConfig.name}` },
    description,
    applicationName: siteConfig.name,
    authors: [{ name: author }],
    creator: author,
    publisher: author,
    /* What the block-2 index and the footer columns are actually about. Not a
       ranking factor any more, but still read by some aggregators. */
    keywords: [
      "travel",
      "slow travel",
      "small group travel",
      "travel planning",
      "destinations",
      "Iceland",
      "Norway",
      "Japan",
      "Indonesia",
    ],
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: shareTitle,
      description,
      url,
      siteName,
      // Dimensions must match the real asset; 1200×630 is the ideal size.
      images: [{ url: ogImage, width: 1200, height: 630, alt: siteConfig.ogImageAlt }],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: shareTitle,
      description,
      site: twitterHandle,
      creator: twitterHandle,
      images: [{ url: ogImage, alt: siteConfig.ogImageAlt }],
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
        { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
        { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        { url: "/android-icon-192x192.png", sizes: "192x192", type: "image/png" },
        { url: "/icon-512x512.png", sizes: "512x512", type: "image/png" },
      ],
      apple: [
        { url: "/apple-icon-180x180.png", sizes: "180x180", type: "image/png" },
      ],
    },
    manifest: "/manifest.json",
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
  };
}

export function generateViewport(): Viewport {
  return {
    themeColor: siteConfig.themeColor,
    width: "device-width",
    initialScale: 1,
  };
}
