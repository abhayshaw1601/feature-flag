import Link from "next/link";
import { AuditView } from "@/components/audit/audit-view";
import { demoAuditOptions, demoAuditNow, filterDemoAudit } from "@/lib/audit/demo";

export default function AuditDemoPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <Link href="/" className="text-sm text-accent underline underline-offset-4">
        Back to Flags
      </Link>
      <p className="text-sm text-muted">
        Local fixture demo, anchored at {demoAuditNow}. These are deterministic summaries, not live
        Gemini output. No account, provider, or database is contacted.
      </p>
      <AuditView
        workspaceId="audit-fixture"
        initialData={filterDemoAudit()}
        options={demoAuditOptions}
        canGenerate={false}
        demo
      />
    </main>
  );
}
