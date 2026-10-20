import Link from "next/link";
import { FlagCreationBar } from "@/components/flags/flag-creation-bar";

export default function FlagCreationDemoPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <Link href="/" className="text-sm text-accent underline underline-offset-4">
        Back to Flags
      </Link>
      <div>
        <h1 className="text-2xl font-medium">Natural-language flag preview</h1>
        <p className="mt-2 text-sm text-muted">
          Phase 5 standalone demo. Review a deterministic draft without signing in or configuring
          Gemini. This does not demonstrate live-model accuracy.
        </p>
      </div>
      <FlagCreationBar
        projectId="local-fixture"
        canGenerate
        demo
        environments={[
          { key: "development", name: "Development" },
          { key: "staging", name: "Staging" },
          { key: "production", name: "Production" },
        ]}
      />
    </main>
  );
}
