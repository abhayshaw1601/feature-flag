"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import { Pencil, X } from "lucide-react";
import type { FlagCreationOutput, FlagType, RuleOperator } from "@flagforge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { previewText, type FlagCreationPreview } from "./flag-creation-preview-data";

const typeLabels: Record<FlagType, string> = {
  RELEASE: "Release",
  OPS: "Ops",
  EXPERIMENT: "Experiment",
  PERMISSION: "Permission",
};

const operatorLabels: Record<RuleOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  in: "is one of",
  not_in: "is not one of",
  contains: "contains",
  starts_with: "starts with",
  greater_than: "is greater than",
  less_than: "is less than",
};

import { useState } from "react";
import { useRouter } from "next/navigation";

type PreviewProps = {
  preview: FlagCreationPreview;
  projectId?: string;
  environments: ReadonlyArray<{ key: string; name: string }>;
  allowProduction: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  editTargetRef: RefObject<HTMLTextAreaElement | null>;
  onDismiss: () => void;
  onSuccess?: () => void;
};

function Rollout({ percent, audience }: { percent: number; audience: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className="font-medium tabular-nums">{percent}%</span> rollout {audience}; the
        remaining {100 - percent}% receive the off variation.
      </p>
      <div className="rollout-track" aria-hidden="true">
        <div className="rollout-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function EnvironmentPreview({
  environment,
  name,
}: {
  environment: FlagCreationOutput["environments"][number];
  name: string;
}) {
  return (
    <article className="min-w-0 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="break-words text-sm font-medium">{previewText(name)}</h4>
        <span className="inline-flex items-center gap-2 text-xs">
          <span
            className={`status-dot ${environment.enabled ? "text-success" : "text-muted"}`}
            aria-hidden="true"
          />
          {environment.enabled ? "On in draft" : "Off in draft"}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-muted">
        {previewText(environment.environmentKey)}
      </p>
      {!environment.enabled ? (
        <p className="mt-3 text-sm text-muted">
          Disabled in this draft. All users would receive the off variation; the configured rules
          and default rollout below would not take effect.
        </p>
      ) : null}
      {environment.rules.rules.length ? (
        <>
          <p className="mt-4 text-xs text-muted">
            Evaluated in order. The first matching rule wins; all conditions in that rule must
            match.
          </p>
          <ol className="mt-3 space-y-3">
            {environment.rules.rules.map((rule, index) => (
              <li
                className="space-y-3 rounded-control border border-border bg-background p-3"
                key={`${rule.id}-${index}`}
              >
                <div>
                  <p className="whitespace-pre-wrap break-words text-sm font-medium">
                    Rule {index + 1}: {previewText(rule.description)}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">
                    {previewText(rule.id)}
                  </p>
                </div>
                <ul className="space-y-2 text-sm">
                  {rule.conditions.map((condition, conditionIndex) => (
                    <li className="break-words" key={conditionIndex}>
                      <span className="font-mono text-xs">{previewText(condition.attribute)}</span>{" "}
                      {operatorLabels[condition.operator]}{" "}
                      <span className="font-mono text-xs">
                        {condition.values
                          .map((value) => previewText(JSON.stringify(value)))
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
                <Rollout percent={rule.serve.rolloutPercent} audience="for matching users" />
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">
          No targeting rules. When enabled, all users use the default rollout.
        </p>
      )}
      <div className="mt-4 space-y-2 border-t border-border pt-3">
        <h5 className="text-sm font-medium">Default rollout</h5>
        <Rollout
          percent={environment.rules.defaultServe.rolloutPercent}
          audience="for users who match no rule"
        />
      </div>
    </article>
  );
}

export function FlagCreationPreviewDrawer({
  preview,
  projectId,
  environments,
  allowProduction,
  returnFocusRef,
  editTargetRef,
  onDismiss,
  onSuccess,
}: PreviewProps) {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    // Fallback when rendered outside of App Router context in offline unit tests
  }
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeIntent = useRef<"dismiss" | "edit">("dismiss");
  const id = useId();
  const { draft } = preview;
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const omitted = environments.filter(
    (environment) => !draft.environments.some((item) => item.environmentKey === environment.key),
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    titleRef.current?.focus();
    return () => {
      dialog?.close();
      const opener = returnFocusRef.current;
      const target =
        closeIntent.current === "edit" || !opener?.isConnected ? editTargetRef.current : opener;
      if (target?.isConnected) target.focus();
    };
  }, [editTargetRef, returnFocusRef]);

  function close(intent: "dismiss" | "edit") {
    closeIntent.current = intent;
    onDismiss();
  }

  async function handleCreate() {
    if (!projectId) {
      setCreateError("No active project found to create this flag.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/flags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: draft.key,
          name: draft.name,
          type: draft.type,
          description: draft.description,
          environments: draft.environments.map((env) => ({
            environmentKey: env.environmentKey,
            enabled: env.enabled,
            rules: env.rules,
          })),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message ?? "Failed to create flag.");
      }
      onSuccess?.();
      onDismiss();
      router?.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-2xl overflow-y-auto border-l border-accent bg-background p-0 text-foreground shadow-popover backdrop:bg-background backdrop:opacity-75"
      onCancel={(event) => {
        event.preventDefault();
        close("dismiss");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <header className="flex items-start justify-between gap-4 border-b border-border p-4 sm:p-6">
        <div className="min-w-0">
          <h2
            ref={titleRef}
            tabIndex={-1}
            id={`${id}-title`}
            className="rounded-control text-xl font-medium focus-visible:outline-accent"
          >
            Flag preview
          </h2>
          <p id={`${id}-description`} className="mt-2 text-sm text-muted">
            Preview only. Review the generated draft; no flag or targeting changes have been saved.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge className="text-accent ring-accent">Generated</Badge>
            {preview.mock ? <Badge>Mock fixture</Badge> : null}
            <span className="min-w-0 break-all text-xs text-muted">
              Model: {previewText(preview.model)}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          aria-label="Dismiss flag preview"
          onClick={() => close("dismiss")}
        >
          <X size={20} aria-hidden="true" />
        </Button>
      </header>

      <div className="space-y-6 p-4 sm:p-6">
        <section aria-labelledby={`${id}-details`}>
          <h3 id={`${id}-details`} className="text-base font-medium">
            Flag details
          </h3>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted">Name</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words font-medium">
                {previewText(draft.name)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Key</dt>
              <dd className="mt-1 break-all font-mono">{previewText(draft.key)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Type</dt>
              <dd className="mt-1">
                <Badge>{typeLabels[draft.type]}</Badge>
              </dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-muted">Description</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words">
                {previewText(draft.description) || "No description provided."}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby={`${id}-environments`} className="space-y-3">
          <h3 id={`${id}-environments`} className="text-base font-medium">
            Environment targeting
          </h3>
          <p className="text-sm text-muted">
            {allowProduction
              ? "You explicitly requested permission to include Production in this draft. This is not approval to enable or save it."
              : "Production was not allowed in this request and must remain off in the draft."}
          </p>
          {draft.environments.length ? (
            draft.environments.map((environment, index) => (
              <EnvironmentPreview
                key={`${environment.environmentKey}-${index}`}
                environment={environment}
                name={
                  environments.find((item) => item.key === environment.environmentKey)?.name ??
                  environment.environmentKey
                }
              />
            ))
          ) : (
            <p className="text-sm text-muted">No environments were included in this draft.</p>
          )}
          <div className="rounded-control border border-border p-3 text-sm text-muted">
            <p>
              Environments omitted from this draft are left disabled, with no targeting proposed.
              Nothing is applied to the project in preview-only mode.
            </p>
            {omitted.length ? (
              <p className="mt-2 break-words">
                Omitted: {omitted.map((environment) => previewText(environment.name)).join(", ")}.
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby={`${id}-assumptions`} className="space-y-2">
          <h3 id={`${id}-assumptions`} className="text-base font-medium">
            Assumptions
          </h3>
          {draft.assumptions.length ? (
            <ul className="list-disc space-y-2 pl-5 text-sm">
              {draft.assumptions.map((assumption, index) => (
                <li className="whitespace-pre-wrap break-words" key={index}>
                  {previewText(assumption)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No assumptions reported.</p>
          )}
        </section>

        <section
          aria-labelledby={`${id}-warnings`}
          className="space-y-2 rounded-card border border-border p-4"
        >
          <h3 id={`${id}-warnings`} className="flex items-center gap-2 text-base font-medium">
            {draft.warnings.length ? (
              <span className="status-dot text-warning" aria-hidden="true" />
            ) : null}
            Warnings
          </h3>
          {draft.warnings.length ? (
            <ul className="list-disc space-y-2 pl-5 text-sm">
              {draft.warnings.map((warning, index) => (
                <li className="whitespace-pre-wrap break-words" key={index}>
                  {previewText(warning)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No warnings reported.</p>
          )}
        </section>
      </div>

      <footer className="space-y-4 border-t border-border p-4 sm:p-6">
        {createError ? (
          <p role="alert" className="text-sm text-danger">
            {createError}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="min-h-11" disabled={creating} onClick={() => close("dismiss")}>
            Dismiss
          </Button>
          <Button className="min-h-11" disabled={creating} onClick={() => close("edit")}>
            <Pencil size={16} aria-hidden="true" /> Edit request
          </Button>
          <Button
            variant="primary"
            className="min-h-11"
            disabled={creating}
            onClick={() => void handleCreate()}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </footer>
    </dialog>
  );
}
