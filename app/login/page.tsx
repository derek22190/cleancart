import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign In",
  robots: {
    index: false,
    follow: true,
  },
};

export default function LoginPage() {
  redirect("/?login=1");
}
