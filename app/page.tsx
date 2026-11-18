import type { Metadata } from "next";
import AnswerBlock from "@/components/AnswerBlock";
import Simulator from "@/components/Simulator";

export const metadata: Metadata = {
  alternates: {
    canonical: "https://www.heybroc.com",
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
