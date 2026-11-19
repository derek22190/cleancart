import type { Metadata } from "next";
import ToolsClient from "./ToolsClient";

export const metadata: Metadata = {
  title: "Free Ingredient Scanner, Seed Oil Checker & Sugar / Refined-Carb Tool",
  description:
    "Paste any food or beverage ingredient list for an instant 0–100 health score, Seed Oil check, Red 40 dye check, Sugar & refined-carb note, and A–Z Additive Encyclopedia.",
  alternates: {
    canonical: "https://www.heybroc.com/tools",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com/tools",
    siteName: "HeyBroc",
    title: "Free Ingredient Scanner, Seed Oil Checker & Sugar / Refined-Carb Tool",
    description:
      "Paste any food or beverage ingredient list for an instant 0–100 health score, Seed Oil check, Red 40 dye check, Sugar & refined-carb note, and A–Z Additive Encyclopedia.",
    images: ["/og-banner.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Free Ingredient Scanner, Seed Oil Checker & Sugar / Refined-Carb Tool",
    description:
      "Paste any food or beverage ingredient list for an instant 0–100 health score, Seed Oil check, Red 40 dye check, Sugar & refined-carb note, and A–Z Additive Encyclopedia.",
    images: ["/og-banner.png"],
  },
};

export default function ToolsPage() {
  return <ToolsClient />;
}
