import { GitBranch, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CleanupScan } from "@/lib/cleanup/fixture";

export function RepositoriesPanel({
  scan,
  busy,
  onScan,
}: {
  scan: CleanupScan;
  busy: boolean;
  onScan: () => void;
}) {
  return (
    <div className="space-y-6">
      <section
        className="rounded-card border border-border p-4 sm:p-6"
        aria-labelledby="repository-name"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="repository-name" className="break-all text-base font-medium">
              {scan.repository.fullName}
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <GitBranch size={16} aria-hidden="true" />
              {scan.repository.branch} · Built-in fixture, not a connected repository
            </p>
          </div>
          <Button className="min-h-11 sm:min-h-9" onClick={onScan} disabled={busy}>
            <RefreshCw size={16} aria-hidden="true" />
            {busy ? "Scanning…" : "Scan fixture"}
          </Button>
        </div>
        <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Flag references</dt>
            <dd className="num mt-1 text-xl">{scan.referenceCount}</dd>
          </div>
          <div>
            <dt className="text-muted">Source files</dt>
            <dd className="num mt-1 text-xl">{scan.fileCount}</dd>
          </div>
          <div>
            <dt className="text-muted">Last fixture scan (UTC)</dt>
            <dd className="num mt-1">
              <time dateTime={scan.scannedAt}>{scan.scannedAt.slice(0, 19).replace("T", " ")}</time>
            </dd>
          </div>
        </dl>
        <details className="mt-6 border-t border-border pt-4">
          <summary className="cursor-pointer rounded-control text-sm font-medium focus-visible:outline-accent">
            View scanned references
          </summary>
          <ul className="mt-3 divide-y divide-border">
            {scan.references.map((reference) => (
              <li
                key={`${reference.filePath}:${reference.line}`}
                className="flex flex-wrap justify-between gap-2 py-3 text-xs"
              >
                <code className="font-mono">{reference.flagKey}</code>
                <code className="break-all font-mono text-muted">
                  {reference.filePath}:{reference.line}
                </code>
              </li>
            ))}
          </ul>
        </details>
      </section>
      <section
        id="github-setup"
        aria-labelledby="github-setup-title"
        className="rounded-card bg-surface p-4 sm:p-6"
      >
        <h2 id="github-setup-title" className="text-base font-medium">
          Connect your own repository next
        </h2>
        <p className="mt-2 text-sm text-muted">
          Live installation and repository access are not implemented yet. The next step is a GitHub
          App with Contents and Pull requests read/write, and Metadata read permissions.
        </p>
        <p className="mt-3 text-sm text-muted">
          Setup and the remaining integration work are documented in{" "}
          <code className="font-mono text-xs">docs/phase7.md</code>. Do not paste tokens or private
          keys into this demo.
        </p>
      </section>
    </div>
  );
}
