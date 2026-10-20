import Link from "next/link";
import { auth } from "@/auth";
import { SettingsView } from "@/components/settings/settings-view";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4">
        <section className="max-w-md rounded-card border border-border bg-surface p-8 text-center">
          <h1 className="text-2xl font-medium">Sign in to open settings</h1>
          <p className="mt-3 text-sm text-muted">
            Workspace members and SDK keys are only visible to authenticated users.
          </p>
          <Link
            className="mt-6 inline-flex min-h-9 items-center justify-center rounded-control bg-foreground px-4 text-sm font-medium text-background hover:opacity-85"
            href="/sign-in"
          >
            Continue with GitHub
          </Link>
        </section>
      </main>
    );
  }

  const membership = await prisma.member.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    include: { workspace: true },
  });
  if (!membership) {
    return <main className="p-8">Your account is not connected to a workspace yet.</main>;
  }

  const [members, invitations, keys, workspace] = await Promise.all([
    prisma.member.findMany({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: "asc" },
      include: {
        user: { select: { id: true, name: true, email: true, image: true, githubUsername: true } },
      },
    }),
    prisma.workspaceInvitation.findMany({
      where: { workspaceId: membership.workspaceId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.sdkKey.findMany({
      where: { environment: { project: { workspaceId: membership.workspaceId } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        type: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
        environment: { select: { id: true, name: true, key: true } },
      },
    }),
    prisma.workspace.findUniqueOrThrow({
      where: { id: membership.workspaceId },
      include: { projects: { include: { environments: true }, orderBy: { name: "asc" } } },
    }),
  ]);

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1120px]">
        <div className="mb-8">
          <p className="text-sm text-muted">Workspace</p>
          <h1 className="mt-1 text-2xl font-medium tracking-[-0.02em]">Settings</h1>
          <p className="mt-2 text-sm text-muted">
            Manage access, members, and the keys your applications use to read configuration.
          </p>
        </div>
        <SettingsView
          workspace={{ id: workspace.id, name: workspace.name }}
          role={membership.role}
          members={members.map((member) => ({
            ...member,
            createdAt: member.createdAt.toISOString(),
          }))}
          invitations={invitations.map((invitation) => ({
            ...invitation,
            createdAt: invitation.createdAt.toISOString(),
          }))}
          keys={keys.map((key) => ({
            ...key,
            createdAt: key.createdAt.toISOString(),
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            revokedAt: key.revokedAt?.toISOString() ?? null,
          }))}
          environments={workspace.projects.flatMap((project) =>
            project.environments.map((environment) => ({
              id: environment.id,
              name: `${project.name} · ${environment.name}`,
            })),
          )}
        />
      </div>
    </main>
  );
}
