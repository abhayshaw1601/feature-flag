import type { Metadata } from "next";
import { AutoRolloutMonitor } from "@/components/auto-rollout/auto-rollout-monitor";

export const metadata: Metadata = {
  title: "Auto-rollout monitor demo | FlagForge",
  description:
    "Run a browser-only synthetic rollout with deterministic guardrails and accelerated time.",
};

export default function AutoRolloutDemoPage() {
  return <AutoRolloutMonitor />;
}
