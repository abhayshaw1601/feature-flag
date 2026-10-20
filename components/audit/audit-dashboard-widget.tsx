import Link from "next/link";
import { auditService } from "@/lib/audit/runtime";
import { AuditDigestCard } from "./audit-digest-card";

export async function AuditDashboardWidget({ workspaceId }: { workspaceId: string }) {
  try {
    const data = await auditService.overview({ workspaceId });
    return <AuditDigestCard digest={data.digest} compact auditHref="/audit" />;
  } catch {
    return (
      <section
        className="rounded-card border border-border bg-surface p-5"
        aria-label="Audit digest unavailable"
      >
        <p className="text-sm text-muted">
          The audit digest is unavailable. Flag management is still available.
        </p>
        <Link href="/audit" className="mt-2 inline-block text-sm text-accent underline">
          Retry on the Audit page
        </Link>
      </section>
    );
  }
}
