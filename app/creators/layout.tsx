import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Creator & Affiliate Partner Program (35% Commission)",
  description:
    "Join the HeyBroc Creator Partner Program. Share honest 0–100 grocery ingredient breakdowns and earn 35% commission on referred Family Pro memberships.",
  alternates: {
    canonical: "https://www.heybroc.com/creators",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com/creators",
    siteName: "HeyBroc",
    title: "Creator & Affiliate Partner Program (35% Commission)",
    description:
      "Join the HeyBroc Creator Partner Program. Share honest 0–100 grocery ingredient breakdowns and earn 35% commission on referred Family Pro memberships.",
    images: ["/og-banner.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Creator & Affiliate Partner Program (35% Commission)",
    description:
      "Join the HeyBroc Creator Partner Program. Share honest 0–100 grocery ingredient breakdowns and earn 35% commission on referred Family Pro memberships.",
    images: ["/og-banner.png"],
  },
};

export default function CreatorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
