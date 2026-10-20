import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/shell/app-shell";
import { prisma } from "@/lib/prisma";
import { AiDemo } from "./ai-demo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI platform | FlagForge" };

export default async function AiPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");

  const membership = await prisma.member.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: {
        include: { projects: { orderBy: { createdAt: "asc" }, take: 1 } },
      },
      user: { select: { name: true } },
    },
  });
  if (!membership) redirect("/sign-in?error=workspace");

  const project = membership.workspace.projects[0] ?? { name: "Default project", key: "default" };

  return (
    <AppShell
      context={{
        workspace: { name: membership.workspace.name },
        project: { name: project.name, key: project.key },
        user: { name: membership.user.name ?? "GitHub user", role: membership.role },
      }}
    >
      <AiDemo
        key={membership.workspaceId}
        workspaceId={membership.workspaceId}
        workspaceName={membership.workspace.name}
      />
    </AppShell>
  );
}
