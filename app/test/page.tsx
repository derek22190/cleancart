import type { Metadata } from "next";
import Simulator from "@/components/Simulator";

export const metadata: Metadata = {
  title: "Free 3-Second Grocery Ingredient Score Test (0–100) | HeyBroc",
  description:
    "Test any grocery item free in 3 seconds. See its instant 0–100 ingredient score, hidden seed oils & synthetic dyes, and 1-tap Clean Swap across Walmart, Target, Costco, Instacart & 8 more stores.",
};

export default function FreeFoodScoreTestPage() {
  return <Simulator initialAdTestMode={true} />;
}
