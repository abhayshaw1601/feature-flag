import type { TargetingSnapshot } from "@/lib/rollout-risk/types";

export function TargetingPreview({
  before,
  after,
  afterLabel = "After confirmation",
}: Readonly<{
  before: TargetingSnapshot;
  after: TargetingSnapshot | null;
  afterLabel?: string;
}>) {
  return (
    <dl className="grid grid-cols-2 gap-4 rounded-control bg-surface p-4">
      {[
        { label: "Before", target: before },
        { label: afterLabel, target: after },
      ].map(({ label, target }) => (
        <div className="min-w-0" key={label}>
          <dt className="text-sm text-muted">{label}</dt>
          <dd className="mt-1">
            <span className="num text-2xl font-medium">
              {target ? `${target.rolloutPercent}%` : "—"}
            </span>
            <span className="mt-1 block text-xs text-muted">
              {target
                ? `${target.enabled ? "Enabled" : "Disabled"}; ${target.rules.rules.length} targeting ${target.rules.rules.length === 1 ? "rule" : "rules"}`
                : "Enter a valid percentage"}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
