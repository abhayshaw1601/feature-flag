import type { Metadata } from "next";
import { RolloutRiskDemo } from "@/components/rollout-risk/rollout-risk-demo";

export const metadata: Metadata = {
  title: "Rollout risk demo | FlagForge",
  description: "Try a deterministic rollout risk assessment using local-only fixtures.",
};

export default function RolloutRiskDemoPage() {
  return <RolloutRiskDemo />;
}
