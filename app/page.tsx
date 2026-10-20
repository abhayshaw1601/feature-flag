import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/shell/app-shell";
import { FlagsPage } from "@/components/flags/flags-page";
import { loadFlags } from "@/lib/flags";
import { prisma } from "@/lib/prisma";
import { Suspense } from "react";
import { AuditDashboardWidget } from "@/components/audit/audit-dashboard-widget";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");

  const membership = await prisma.member.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: {
        include: {
          projects: {
            orderBy: { createdAt: "asc" },
            take: 1,
            include: {
              environments: {
                select: { key: true, name: true },
                orderBy: { createdAt: "asc" },
              },
            },
          },
          members: { select: { user: { select: { id: true, name: true } } } },
        },
      },
      user: { select: { name: true } },
    },
  });
  if (!membership) redirect("/sign-in?error=workspace");

  const project = membership.workspace.projects[0];
  if (!project) redirect("/settings");
  const initialData = await loadFlags(project.id);

  return (
    <AppShell
      context={{
        workspace: { name: membership.workspace.name },
        project: { name: project.name, key: project.key },
        user: { name: membership.user.name ?? "GitHub user", role: membership.role },
      }}
    >
      <div className="space-y-6">
        <FlagsPage
          initialData={initialData}
          project={{ id: project.id, name: project.name }}
          members={membership.workspace.members.map(({ user }) => ({
            id: user.id,
            name: user.name ?? "Unnamed user",
          }))}
          environments={project.environments}
          canCreate={membership.role !== "VIEWER"}
        />
        <Suspense
          fallback={
            <div className="skeleton h-32 w-full" aria-label="Loading audit digest" role="status" />
          }
        >
          <AuditDashboardWidget workspaceId={membership.workspaceId} />
        </Suspense>
      </div>
    </AppShell>
  );
}
