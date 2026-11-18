import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shop Cleaner with HeyBroc Invite",
  robots: {
    index: false,
    follow: true,
  },
};

export default function ReferralInviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
