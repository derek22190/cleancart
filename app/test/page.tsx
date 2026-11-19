import type { Metadata } from "next";
import AnswerBlock from "@/components/AnswerBlock";
import Simulator from "@/components/Simulator";

export const metadata: Metadata = {
  title: "Free 3-Second Grocery Ingredient Score Test (0–100)",
  description:
    "Test any grocery item free in 3 seconds. See its instant 0–100 ingredient score, hidden seed oils & synthetic dyes, and 1-tap Clean Swap across Walmart, Target, Costco, Instacart & 8 more stores.",
  alternates: {
    canonical: "https://www.heybroc.com/test",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com/test",
    siteName: "HeyBroc",
    title: "Free 3-Second Grocery Ingredient Score Test (0–100)",
    description:
      "Test any grocery item free in 3 seconds. See its instant 0–100 ingredient score, hidden seed oils & synthetic dyes, and 1-tap Clean Swap across Walmart, Target, Costco, Instacart & 8 more stores.",
    images: ["/og-banner.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Free 3-Second Grocery Ingredient Score Test (0–100)",
    description:
      "Test any grocery item free in 3 seconds. See its instant 0–100 ingredient score, hidden seed oils & synthetic dyes, and 1-tap Clean Swap across Walmart, Target, Costco, Instacart & 8 more stores.",
    images: ["/og-banner.png"],
  },
};

export default function FreeFoodScoreTestPage() {
  return (
    <>
      <Simulator initialAdTestMode={true} />
      <AnswerBlock />
    </>
  );
}
