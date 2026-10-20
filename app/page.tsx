import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AppShell } from "@/components/shell/app-shell";
import { FlagsPage } from "@/components/flags/flags-page";
import { loadFlags } from "@/lib/flags";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function HomePage() {
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

  const { flags, source } = await loadFlags();
  const project = membership.workspace.projects[0] ?? { name: "Default project", key: "default" };

  return (
    <AppShell
      context={{
        workspace: { name: membership.workspace.name },
        project: { name: project.name, key: project.key },
        user: { name: membership.user.name ?? "GitHub user", role: membership.role },
      }}
    >
      <FlagsPage initialFlags={flags} dataSource={source} />
    </AppShell>
  );
}
