import type { Metadata } from "next";
import { CleanupPage } from "@/components/cleanup/cleanup-page";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Repositories | FlagForge" };

export default function RepositoriesPage() {
  return <CleanupPage view="repositories" />;
}
