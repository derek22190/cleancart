import type { Metadata } from "next";
import ToolsClient from "./ToolsClient";

export const metadata: Metadata = {
  title: "Free Ingredient Scanner, Seed Oil Checker & Blood Sugar Food Tool",
  description:
    "Paste any food or cosmetic ingredient list for an instant 0–100 health score, Seed Oil check, Red 40 dye check, Blood Sugar / PCOS spike analysis, and A–Z Additive Encyclopedia.",
  alternates: {
    canonical: "https://www.heybroc.com/tools",
  },
};

export default function ToolsPage() {
  return <ToolsClient />;
}
