import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { FlagDetailView } from "@/components/flags/flag-detail";
import {
  FlagServiceError,
  loadFlagDetail,
  loadFlagHistory,
  requireFlagProjectAccess,
} from "@/lib/flags";

export const dynamic = "force-dynamic";

export default async function FlagPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const [flag, initialHistory] = await Promise.all([loadFlagDetail(id), loadFlagHistory(id)]);
    const access = await requireFlagProjectAccess(flag.projectId);
    return (
      <AppShell
        context={{
          workspace: { name: access.workspace.name },
          project: { name: access.project.name, key: access.project.key },
          user: { name: access.actor.name ?? "GitHub user", role: access.role },
        }}
      >
        <FlagDetailView flag={flag} initialHistory={initialHistory} />
      </AppShell>
    );
  } catch (error) {
    if (error instanceof FlagServiceError) {
      if (error.status === 401) redirect("/sign-in");
      if (error.status === 404 || error.status === 403) notFound();
    }
    throw error;
  }
}
