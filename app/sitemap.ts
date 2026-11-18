import type { MetadataRoute } from "next";
import { hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { SEO_PRODUCTS } from "@/lib/seo-catalog";

const SITE_UPDATED = new Date("2026-11-18");

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://www.heybroc.com";

  const productUrls: MetadataRoute.Sitemap = SEO_PRODUCTS.filter((p) =>
    hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)
  ).map((p) => ({
    url: `${baseUrl}/swaps/${p.slug}`,
    lastModified: new Date(p.verifiedAt),
    changeFrequency: "weekly",
    priority: 0.85,
  }));

  return [
    {
      url: baseUrl,
      lastModified: SITE_UPDATED,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/test`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/independence`,
      lastModified: SITE_UPDATED,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/tools`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.95,
    },
    {
      url: `${baseUrl}/swaps`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.95,
    },
    ...productUrls,
    {
      url: `${baseUrl}/creators`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.85,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: SITE_UPDATED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: SITE_UPDATED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/llms.txt`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/llms-full.txt`,
      lastModified: SITE_UPDATED,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];
}
