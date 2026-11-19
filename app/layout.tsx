import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://www.heybroc.com"),
  title: {
    default: "HeyBroc - Online Food Scanner (0–100 Ingredient Score & Clean Swaps)",
    template: "%s | HeyBroc",
  },
  description:
    "Instant 0–100 online food & grocery ingredient scanner with sugar & refined-carb notes and 1-Tap Clean Swaps across Walmart, Instacart, Target, Kroger, ALDI, Costco & 12 stores.",
  keywords: [
    "online food scanner",
    "clean food scanner",
    "ingredient scanner app",
    "seed oil scanner",
    "grocery ingredient checker",
    "healthy grocery swaps",
    "food additive checker",
    "Red 40 scanner",
    "online grocery health score",
    "Walmart clean food swaps",
    "Instacart healthy food scanner",
    "Target clean groceries",
    "ALDI clean food scanner",
    "HeyBroc",
  ],
  openGraph: {
    type: "website",
    siteName: "HeyBroc",
    title: "HeyBroc - Online Food Scanner | Shop Clean. Skip the Junk.",
    description:
      "Grades grocery food & beverage products from 0–100 with sugar & refined-carb notes and 1-Tap Clean Swaps on Walmart, Target, Instacart, ALDI, Kroger & Costco.",
    images: [
      {
        url: "/og-banner.png",
        width: 1024,
        height: 500,
        alt: "HeyBroc - Online Food Scanner (0–100 Score & 1-Tap Clean Swaps)",
      },
    ],
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "HeyBroc - Online Food Scanner + 1-Tap Clean Swaps",
    description:
      "Instant 0–100 ingredient health scores, sugar & refined-carb notes & 1-Tap Clean Swaps across Walmart, Target, Instacart, Kroger, ALDI & 12 stores.",
    images: ["/og-banner.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  manifest: "/manifest.json",
  icons: {
    icon: "/broc-mascot.png",
    shortcut: "/broc-mascot.png",
    apple: "/broc-mascot.png",
  },
  appleWebApp: {
    capable: true,
    title: "HeyBroc",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f3ee",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.heybroc.com/#organization",
      name: "HeyBroc",
      url: "https://www.heybroc.com",
      logo: "https://www.heybroc.com/broc-mascot.png",
      description:
        "Independent 0–100 online food and grocery ingredient grading engine and Live Shop grocery assistant.",
    },
    {
      "@type": "WebSite",
      "@id": "https://www.heybroc.com/#website",
      url: "https://www.heybroc.com",
      name: "HeyBroc",
      publisher: {
        "@id": "https://www.heybroc.com/#organization",
      },
      potentialAction: {
        "@type": "SearchAction",
        target: "https://www.heybroc.com/?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.heybroc.com/#app",
      name: "HeyBroc - Online Food Scanner",
      operatingSystem: "Android, iOS, Chrome, Safari, Web",
      applicationCategory: "HealthApplication",
      url: "https://www.heybroc.com",
      downloadUrl: "https://www.heybroc.com/heybroc.apk",
      screenshot: "https://www.heybroc.com/og-banner.png",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "3-Pillar 0–100 Ingredient & Nutrition Score (60% Nutrition, 30% Additives, 10% USDA Certified Organic)",
        "On-photo Live Shop badges across Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's, Amazon Fresh, Whole Foods, DoorDash, Uber Eats & Shipt",
        "1-Tap Clean Swaps in the exact same grocery sub-category",
        "Flags Seed Oils, Red 40, Titanium Dioxide, BHA/BHT, Nitrites, Carrageenan & HFCS",
      ],
    },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jakarta.variable}>
      <head>
        <meta
          name="impact-site-verification"
          {...({ value: "dd34dc80-a3ee-41d1-8a59-ee030cf929f9" } as Record<string, string>)}
        />
        <link rel="preconnect" href="https://images.openfoodfacts.org" crossOrigin="anonymous" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0, pointerEvents: "none" }}>
          Impact-Site-Verification: dd34dc80-a3ee-41d1-8a59-ee030cf929f9
        </span>
        {children}
      </body>
    </html>
  );
}
