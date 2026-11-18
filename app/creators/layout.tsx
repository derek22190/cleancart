import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Creator & Affiliate Partner Program (35% Commission)",
  description:
    "Join the HeyBroc Creator Partner Program. Share honest 0–100 grocery ingredient breakdowns and earn 35% commission on referred Family Pro memberships.",
  alternates: {
    canonical: "https://www.heybroc.com/creators",
  },
};

export default function CreatorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
