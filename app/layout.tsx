import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "HeyBroc — Clean Grocery Scanner & 1-Tap Clean Swaps",
  description:
    "Instant 0–100 ingredient grader and 1-tap clean grocery swaps across Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Fresh, Sam's Club, BJ's, Costco & Shipt.",
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body>{children}</body>
    </html>
  );
}
