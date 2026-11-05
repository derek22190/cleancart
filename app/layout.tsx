import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "CleanCart PureOverlay — Ingredient Grader & 1-Tap Clean Swaps",
  description:
    "Interactive simulator for CleanCart: a deterministic, ingredient-only grocery grader that floats over Walmart, Instacart, Sam's Club and BJ's with 1-tap clean swaps.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f3ee",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>{children}</body>
    </html>
  );
}
