import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { auditService } from "@/lib/audit/runtime";
import { loadAuditOptions } from "@/lib/audit/repository";
import { AppShell } from "@/components/shell/app-shell";
import { AuditView } from "@/components/audit/audit-view";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");
  const membership = await prisma.member.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: { include: { projects: { take: 1, orderBy: { createdAt: "asc" } } } },
      user: { select: { name: true } },
    },
  });
  if (!membership) redirect("/sign-in?error=workspace");
  const [initialData, options] = await Promise.all([
    auditService.overview({ workspaceId: membership.workspaceId }),
    loadAuditOptions(prisma, membership.workspaceId),
  ]);
  const project = membership.workspace.projects[0];
  return (
    <AppShell
      context={{
        workspace: { name: membership.workspace.name },
        project: { name: project?.name ?? "All projects", key: project?.key ?? "all" },
        user: { name: membership.user.name ?? "GitHub user", role: membership.role },
      }}
    >
      <AuditView
        workspaceId={membership.workspaceId}
        initialData={initialData}
        options={options}
        canGenerate={membership.role !== "VIEWER"}
      />
    </AppShell>
  );
}
