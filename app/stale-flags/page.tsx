import type { Metadata } from "next";
import { CleanupPage } from "@/components/cleanup/cleanup-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stale flags | FlagForge" };

export default function StaleFlagsPage() {
  return <CleanupPage view="stale" />;
}
