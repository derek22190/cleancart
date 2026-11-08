import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/stripe/"],
      },
      // Explicitly welcome AI / Generative Engine Optimization (GEO) crawlers
      {
        userAgent: [
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "PerplexityBot",
          "ClaudeBot",
          "anthropic-ai",
          "Google-Extended",
          "Applebot-Extended",
          "Amazonbot",
        ],
        allow: ["/", "/llms.txt", "/llms-full.txt", "/privacy"],
      },
    ],
    sitemap: "https://www.heybroc.com/sitemap.xml",
    host: "https://www.heybroc.com",
  };
}
