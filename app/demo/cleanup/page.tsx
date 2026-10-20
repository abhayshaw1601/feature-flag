import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { CleanupWorkspace } from "@/components/cleanup/cleanup-workspace";
import { scanCleanupFixture } from "@/lib/cleanup/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cleanup fixture demo | FlagForge" };

export default async function CleanupDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  return (
    <AppShell
      context={{
        workspace: { name: "Cleanup fixture" },
        project: { name: "Storefront fixture", key: "fixture_storefront" },
        user: { name: "Demo visitor", role: "Preview only" },
      }}
    >
      <CleanupWorkspace
        initialScan={scanCleanupFixture()}
        view={view === "repositories" ? "repositories" : "stale"}
        demo
      />
    </AppShell>
  );
}
