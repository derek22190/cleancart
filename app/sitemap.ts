import type { MetadataRoute } from "next";
import { hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { SEO_PRODUCTS } from "@/lib/seo-catalog";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://www.heybroc.com";
  const lastModified = new Date();

  const productUrls: MetadataRoute.Sitemap = SEO_PRODUCTS.filter((p) =>
    hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)
  ).map((p) => ({
    url: `${baseUrl}/swaps/${p.slug}`,
    lastModified,
    changeFrequency: "weekly",
    priority: 0.85,
  }));

  return [
    {
      url: baseUrl,
      lastModified,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/tools`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.95,
    },
    {
      url: `${baseUrl}/swaps`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.95,
    },
    ...productUrls,
    {
      url: `${baseUrl}/privacy`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/llms.txt`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/llms-full.txt`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.9,
    },
  ];
}
