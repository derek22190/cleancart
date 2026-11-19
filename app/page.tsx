import type { Metadata } from "next";
import AnswerBlock from "@/components/AnswerBlock";
import Simulator from "@/components/Simulator";

export const metadata: Metadata = {
  alternates: {
    canonical: "https://www.heybroc.com",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com",
    siteName: "HeyBroc",
    locale: "en_US",
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
  },
  twitter: {
    card: "summary_large_image",
    title: "HeyBroc - Online Food Scanner + 1-Tap Clean Swaps",
    description:
      "Instant 0–100 ingredient health scores, sugar & refined-carb notes & 1-Tap Clean Swaps across Walmart, Target, Instacart, Kroger, ALDI & 12 stores.",
    images: ["/og-banner.png"],
  },
};

export default function Home() {
  return (
    <>
      <Simulator />
      <AnswerBlock />
    </>
  );
}
