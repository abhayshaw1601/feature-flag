"use client";

import { Copy, KeyRound, Save, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { MemberRole, SdkKeyType } from "@prisma/client";
import { Button } from "@/components/ui/button";

type Member = {
  id: string;
  role: MemberRole;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    githubUsername: string | null;
  };
};
type Invitation = { id: string; githubUsername: string; role: MemberRole; createdAt: string };
type SdkKey = {
  id: string;
  name: string;
  type: SdkKeyType;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  environment: { id: string; name: string; key: string };
};

function date(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function SettingsView({
  workspace,
  role,
  members: initialMembers,
  invitations: initialInvitations,
  keys: initialKeys,
  environments,
}: Readonly<{
  workspace: { id: string; name: string };
  role: MemberRole;
  members: Member[];
  invitations: Invitation[];
  keys: SdkKey[];
  environments: Array<{ id: string; name: string }>;
}>) {
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [keys, setKeys] = useState(initialKeys);
  const [username, setUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("VIEWER");
  const [environmentId, setEnvironmentId] = useState(environments[0]?.id ?? "");
  const [keyName, setKeyName] = useState("");
  const [keyType, setKeyType] = useState<SdkKeyType>("SERVER");
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canManage = role === "OWNER" || role === "ADMIN";

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "Request failed.");
    return body.data;
  }

  async function saveWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await request(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: workspaceName }),
      });
      setMessage("Workspace name saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Workspace name could not be saved.");
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await request(`/api/workspaces/${workspace.id}/invitations`, {
        method: "POST",
        body: JSON.stringify({ githubUsername: username, role: inviteRole }),
      });
      if (result.kind === "member") setMembers((current) => [...current, result.member]);
      else setInvitations((current) => [result.invitation, ...current]);
      setUsername("");
      setMessage("Invitation saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Invitation could not be saved.");
    }
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await request(`/api/workspaces/${workspace.id}/sdk-keys`, {
        method: "POST",
        body: JSON.stringify({
          environmentId,
          name: keyName || `${keyType === "SERVER" ? "Server" : "Client"} key`,
          type: keyType,
        }),
      });
      setKeys((current) => [
        {
          ...result,
          lastUsedAt: null,
          revokedAt: null,
          environment: { id: result.environmentId, name: result.environmentName, key: "" },
        },
        ...current,
      ]);
      setOneTimeSecret(result.secret);
      setKeyName("");
      setMessage("SDK key created. Copy the secret before closing this notice.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "SDK key could not be created.");
    }
  }

  async function revoke(key: SdkKey) {
    if (
      !window.confirm(
        `Revoke “${key.name}”? Applications using this key will stop receiving configuration.`,
      )
    )
      return;
    try {
      const result = await request(`/api/workspaces/${workspace.id}/sdk-keys/${key.id}/revoke`, {
        method: "POST",
      });
      setKeys((current) =>
        current.map((item) =>
          item.id === key.id ? { ...item, revokedAt: result.revokedAt } : item,
        ),
      );
      setMessage("SDK key revoked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "SDK key could not be revoked.");
    }
  }

  return (
    <div className="space-y-8">
      <section
        className="grid gap-6 border-b border-border pb-8 lg:grid-cols-[280px_1fr]"
        aria-labelledby="workspace-heading"
      >
        <div>
          <h2 id="workspace-heading" className="text-base font-medium">
            Workspace
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            This name appears in the workspace switcher and member invitations.
          </p>
        </div>
        <form className="max-w-xl space-y-3" onSubmit={saveWorkspace}>
          <label className="block text-sm font-medium" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            className="h-10 w-full rounded-control border border-border-strong bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            id="workspace-name"
            name="workspaceName"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            disabled={!canManage}
          />
          <Button type="submit" variant="primary" disabled={!canManage}>
            <Save size={15} aria-hidden="true" />
            Save name
          </Button>
        </form>
      </section>

      <section
        className="grid gap-6 border-b border-border pb-8 lg:grid-cols-[280px_1fr]"
        aria-labelledby="members-heading"
      >
        <div>
          <h2 id="members-heading" className="text-base font-medium">
            Members
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Invite teammates by their GitHub username. Existing accounts join immediately.
          </p>
        </div>
        <div className="space-y-5">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={invite}>
            <label className="sr-only" htmlFor="github-username">
              GitHub username
            </label>
            <input
              className="h-10 min-w-0 flex-1 rounded-control border border-border-strong bg-background px-3 outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
              id="github-username"
              name="githubUsername"
              placeholder="GitHub username…"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={!canManage}
            />
            <label className="sr-only" htmlFor="invite-role">
              Invite role
            </label>
            <select
              className="h-10 rounded-control border border-border-strong bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              id="invite-role"
              name="inviteRole"
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as MemberRole)}
              disabled={!canManage}
            >
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Editor</option>
              <option value="ADMIN">Admin</option>
            </select>
            <Button type="submit" variant="secondary" disabled={!canManage}>
              <UserPlus size={15} aria-hidden="true" />
              Invite
            </Button>
          </form>
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full min-w-[620px] text-left text-sm">
              <caption className="sr-only">Workspace members</caption>
              <thead className="border-b border-border text-xs text-muted">
                <tr>
                  <th className="px-4 py-3" scope="col">
                    Member
                  </th>
                  <th className="px-4 py-3" scope="col">
                    GitHub
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Role
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr className="border-b border-border last:border-b-0" key={member.id}>
                    <td className="px-4 py-3">{member.user.name ?? "GitHub user"}</td>
                    <td className="px-4 py-3 text-muted">
                      @{member.user.githubUsername ?? "unknown"}
                    </td>
                    <td className="px-4 py-3">{member.role}</td>
                    <td className="px-4 py-3 text-muted">{date(member.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invitations.length ? (
            <div>
              <h3 className="text-sm font-medium">Pending invitations</h3>
              <ul className="mt-2 space-y-2 text-sm text-muted">
                {invitations.map((invitation) => (
                  <li key={invitation.id}>
                    @{invitation.githubUsername} · {invitation.role} · sent{" "}
                    {date(invitation.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid gap-6 pb-8 lg:grid-cols-[280px_1fr]" aria-labelledby="keys-heading">
        <div>
          <h2 id="keys-heading" className="text-base font-medium">
            SDK keys
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Keys authenticate configuration requests. The secret is shown once and stored only as a
            hash.
          </p>
        </div>
        <div className="space-y-5">
          <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={createKey}>
            <label className="sr-only" htmlFor="key-name">
              Key name
            </label>
            <input
              className="h-10 rounded-control border border-border-strong bg-background px-3 outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
              id="key-name"
              name="keyName"
              placeholder="Key name…"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              disabled={!canManage}
            />
            <label className="sr-only" htmlFor="key-environment">
              Environment
            </label>
            <select
              className="h-10 rounded-control border border-border-strong bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              id="key-environment"
              name="keyEnvironment"
              value={environmentId}
              onChange={(event) => setEnvironmentId(event.target.value)}
              disabled={!canManage}
            >
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary" disabled={!canManage}>
              <KeyRound size={15} aria-hidden="true" />
              Create key
            </Button>
          </form>
          <div className="flex gap-2 text-sm">
            <span className="text-muted">Key type</span>
            <button
              className={
                keyType === "SERVER"
                  ? "font-medium text-foreground underline underline-offset-4"
                  : "text-muted"
              }
              type="button"
              onClick={() => setKeyType("SERVER")}
            >
              Server
            </button>
            <button
              className={
                keyType === "CLIENT"
                  ? "font-medium text-foreground underline underline-offset-4"
                  : "text-muted"
              }
              type="button"
              onClick={() => setKeyType("CLIENT")}
            >
              Client
            </button>
          </div>
          {oneTimeSecret ? (
            <div className="rounded-card border border-warning bg-background p-4">
              <p className="text-sm font-medium">Copy this secret now</p>
              <p className="mt-1 text-xs text-muted">
                It will not be shown again after this panel is closed.
              </p>
              <div className="mt-3 flex gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control bg-surface p-2 font-mono text-xs">
                  {oneTimeSecret}
                </code>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Copy SDK secret"
                  onClick={() => navigator.clipboard.writeText(oneTimeSecret)}
                >
                  <Copy size={15} aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setOneTimeSecret(null)}>
                  Done
                </Button>
              </div>
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">SDK keys</caption>
              <thead className="border-b border-border text-xs text-muted">
                <tr>
                  <th className="px-4 py-3" scope="col">
                    Name
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Type
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Environment
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Prefix
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Created
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Last used
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr className="border-b border-border last:border-b-0" key={key.id}>
                    <td className="px-4 py-3 font-medium">{key.name}</td>
                    <td className="px-4 py-3">{key.type}</td>
                    <td className="px-4 py-3">{key.environment.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{key.prefix}</td>
                    <td className="px-4 py-3 text-muted">{date(key.createdAt)}</td>
                    <td className="px-4 py-3 text-muted">{date(key.lastUsedAt)}</td>
                    <td className="px-4 py-3">
                      {key.revokedAt ? (
                        <span className="text-muted">Revoked</span>
                      ) : (
                        <Button variant="quiet" size="sm" onClick={() => revoke(key)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      {message ? (
        <p
          className="fixed bottom-5 right-5 z-40 rounded-control border border-border bg-surface px-3 py-2 text-sm shadow-popover"
          role="status"
          aria-live="polite"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
