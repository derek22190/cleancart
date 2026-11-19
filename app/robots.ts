import type { MetadataRoute } from "next";

const ALLOWED_PATHS = ["/", "/llms.txt", "/llms-full.txt", "/api/product-image"];
const DISALLOWED_PATHS = ["/api/", "/admin", "/login", "/r/", "/auth/"];

const AI_BOTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "Claude-SearchBot",
  "Claude-User",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "Amazonbot",
  "DuckAssistBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ALLOWED_PATHS,
        disallow: DISALLOWED_PATHS,
      },
      // Explicitly welcome AI / Generative Engine Optimization (GEO) crawlers on public content while protecting API & admin routes
      {
        userAgent: AI_BOTS,
        allow: ALLOWED_PATHS,
        disallow: DISALLOWED_PATHS,
      },
    ],
    sitemap: "https://www.heybroc.com/sitemap.xml",
    host: "https://www.heybroc.com",
  };
}

