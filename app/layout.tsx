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
    "Instant 0–100 online food, cosmetic & grocery ingredient scanner with blood sugar / glucose spike insights and 1-Tap Clean Swaps across Walmart, Instacart, Target, Kroger, ALDI, Costco & 12 stores.",
  keywords: [
    "online food scanner",
    "clean food scanner",
    "ingredient scanner app",
    "seed oil scanner",
    "glucose spike food scanner",
    "PCOS food scanner",
    "diabetic grocery scanner",
    "healthy grocery swaps",
    "food additive checker",
    "Red 40 scanner",
    "online grocery health score",
    "Walmart clean food swaps",
    "Instacart healthy food scanner",
    "Target clean groceries",
    "ALDI clean food scanner",
    "non-toxic cosmetic scanner",
    "HeyBroc",
  ],
  alternates: {
    canonical: "https://www.heybroc.com",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com",
    siteName: "HeyBroc",
    title: "HeyBroc - Online Food Scanner | Shop Clean. Skip the Junk.",
    description:
      "Grades 7.5M+ grocery, cosmetic & household products from 0–100 with blood sugar impact & 1-Tap Clean Swaps on Walmart, Target, Instacart, ALDI, Kroger & Costco.",
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
      "Instant 0–100 ingredient health scores, blood sugar insights & 1-Tap Clean Swaps across Walmart, Target, Instacart, Kroger, ALDI & 12 stores.",
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
    icon: "/broc-mascot.jpg",
    shortcut: "/broc-mascot.jpg",
    apple: "/broc-mascot.jpg",
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
      logo: "https://www.heybroc.com/broc-mascot.jpg",
      description:
        "Independent 0–100 online food, cosmetic, and household ingredient grading engine and floating grocery shopping assistant.",
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
        "3-Pillar 0–100 Ingredient & Nutrition Score (60% Nutrition, 30% Additives, 10% Organic)",
        "Live Store Floating Bubble on Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's, Amazon Fresh, DoorDash, Uber Eats & Shipt",
        "1-Tap Clean Swaps in the exact same grocery sub-category",
        "Flags Seed Oils, Red 40, Titanium Dioxide, BHA/BHT, Nitrites, Carrageenan, HFCS & Parabens",
        "7.5M+ Food, Cosmetic & Household Products Indexed",
      ],
    },
    {
      "@type": "FAQPage",
      "@id": "https://www.heybroc.com/#faq",
      mainEntity: [
        {
          "@type": "Question",
          name: "How does HeyBroc calculate its 0 to 100 food and ingredient score?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "HeyBroc grades products on a deterministic 0–100 scale across three pillars: Nutritional Quality (60% weight, based on sugar, sodium, saturated fat, calories, fiber, and protein), Additive & Chemical Safety (30% weight, penalizing synthetic dyes, refined seed oils, chemical preservatives, nitrites, and emulsifiers), and a Certified Organic Bonus (10% weight). Any high-risk additive automatically caps a product's maximum score at 49/100.",
          },
        },
        {
          "@type": "Question",
          name: "Which grocery stores work with the HeyBroc floating bubble?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "HeyBroc's Live Store Bubble works automatically across 12 major grocery stores and delivery apps: Walmart, Instacart, Target, Kroger, ALDI, Costco, Sam's Club, BJ's Wholesale, Amazon Fresh, DoorDash, Uber Eats, and Shipt—without needing to scan physical barcodes.",
          },
        },
        {
          "@type": "Question",
          name: "What ingredients and additives does HeyBroc flag?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "HeyBroc flags refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower), artificial food dyes (Red 40, Yellow 5, Yellow 6, Blue 1, Red 3, Titanium Dioxide), preservatives and nitrates (Sodium Nitrite, BHA, BHT, Potassium Bromate, TBHQ, Sodium Benzoate), sweeteners (High Fructose Corn Syrup, Sucralose, Aspartame, Ace-K), emulsifiers (Carrageenan, Polysorbate 80), and cosmetic endocrine disruptors (Parabens, Phthalates, PFAS).",
          },
        },
        {
          "@type": "Question",
          name: "Does HeyBroc accept payments from brands to change product scores?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "No. HeyBroc is 100% independent. Brands cannot pay to alter a score or buy placement in Top Picks. Every product score and 1-for-1 Clean Swap is computed deterministically from its ingredient list and nutrition facts.",
          },
        },
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
