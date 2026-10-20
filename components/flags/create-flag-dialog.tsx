"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import {
  createFlagRequestSchema,
  flagSummarySchema,
  type FlagSummary,
  type FlagType,
} from "@flagforge/contracts";
import { Button } from "@/components/ui/button";
import { FlagApiError, requestErrorMessage, requestFlagData } from "./flag-api";
import { fieldClassName, primaryActionClassName, typeLabels } from "./flag-ui";

export type CreateFlagDialogProps = {
  project: { id: string; name: string };
  members: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: (flag: FlagSummary) => void;
};

export function generateFlagKey(name: string) {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name.trim()) return "";
  return (/^[a-z]/.test(normalized) ? normalized : `flag_${normalized || "new"}`).slice(0, 80);
}

type Field = "name" | "key" | "type" | "description" | "tags" | "ownerId";

export function CreateFlagDialog({ project, members, onClose, onCreated }: CreateFlagDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const id = useId();
  const [values, setValues] = useState({
    name: "",
    key: "",
    type: "RELEASE" as FlagType,
    description: "",
    tags: "",
    ownerId: "",
  });
  const [keyEdited, setKeyEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => {
      requestRef.current?.abort();
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (submitting) dialogRef.current?.focus();
    else if (error) {
      const invalid = dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      (invalid ?? errorRef.current)?.focus();
    }
  }, [submitting, error, errors]);

  function update(field: Field, value: string) {
    setValues((previous) => ({
      ...previous,
      [field]: value,
      ...(field === "name" && !keyEdited ? { key: generateFlagKey(value) } : {}),
    }));
    if (field === "key") setKeyEdited(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const parsed = createFlagRequestSchema.safeParse({
      ...values,
      tags: values.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      ownerId: values.ownerId || null,
    });
    if (!parsed.success) {
      const nextErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        (nextErrors[field] ??= []).push(
          field === "key" && issue.code === "invalid_string"
            ? "Start with a lowercase letter; use only lowercase letters, numbers, and underscores."
            : issue.message,
        );
      }
      setErrors(nextErrors);
      setError("Check the highlighted fields.");
      return;
    }
    busyRef.current = true;
    setSubmitting(true);
    setErrors({});
    setError(null);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const flag = await requestFlagData(
        `/api/projects/${encodeURIComponent(project.id)}/flags`,
        flagSummarySchema,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted) onCreated(flag);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setErrors(cause instanceof FlagApiError ? cause.fieldErrors : {});
        setError(requestErrorMessage(cause));
      }
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  function field(fieldName: Field, label: string, control: ReactNode, hint?: string) {
    return (
      <div className="min-w-0 space-y-2">
        <label htmlFor={`${id}-${fieldName}`} className="block text-sm font-medium">
          {label}
        </label>
        {control}
        {hint ? (
          <p id={`${id}-${fieldName}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
        {errors[fieldName]?.length ? (
          <p id={`${id}-${fieldName}-error`} className="text-xs text-foreground">
            {errors[fieldName].join(" ")}
          </p>
        ) : null}
      </div>
    );
  }

  function attributes(fieldName: Field, hint = false) {
    return {
      id: `${id}-${fieldName}`,
      name: fieldName,
      className: fieldClassName,
      "aria-invalid": Boolean(errors[fieldName]?.length),
      "aria-describedby":
        [
          hint ? `${id}-${fieldName}-hint` : "",
          errors[fieldName]?.length ? `${id}-${fieldName}-error` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
    };
  }

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-card border border-border bg-background p-0 text-foreground shadow-popover backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        if (!busyRef.current) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Stop the key's native close action too: some repeated native cancel
          // events are not cancelable, even when onCancel calls preventDefault.
          event.preventDefault();
          event.stopPropagation();
          if (!busyRef.current) onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (busyRef.current || !first) {
          event.preventDefault();
          dialogRef.current?.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border p-5">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-medium">
            Create flag
          </h2>
          <p id={`${id}-description`} className="mt-1 break-words text-sm text-muted">
            Add a feature flag to {project.name}.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close create flag"
          disabled={submitting}
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </Button>
      </div>
      <form noValidate onSubmit={submit} aria-busy={submitting}>
        <div className="space-y-4 p-5">
          {error ? (
            <div
              ref={errorRef}
              tabIndex={-1}
              role="alert"
              className="rounded-control border border-danger px-3 py-2 text-sm"
            >
              {error}
            </div>
          ) : null}
          <fieldset disabled={submitting} inert={submitting} className="min-w-0 space-y-4">
            <legend className="sr-only">Flag details</legend>
            {field(
              "name",
              "Name",
              <input
                ref={nameRef}
                {...attributes("name")}
                value={values.name}
                onChange={(event) => update("name", event.target.value)}
                required
                maxLength={120}
                autoComplete="off"
                placeholder="Checkout refresh"
              />,
            )}
            {field(
              "key",
              "Key",
              <input
                {...attributes("key", true)}
                className={`${fieldClassName} font-mono`}
                value={values.key}
                onChange={(event) => update("key", event.target.value)}
                required
                maxLength={80}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
              />,
              "Generated from the name until you edit it. Use lowercase letters, numbers, and underscores; start with a letter.",
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {field(
                "type",
                "Type",
                <select
                  {...attributes("type")}
                  value={values.type}
                  onChange={(event) => update("type", event.target.value)}
                >
                  {Object.entries(typeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>,
              )}
              {field(
                "ownerId",
                "Owner (optional)",
                <select
                  {...attributes("ownerId")}
                  value={values.ownerId}
                  onChange={(event) => update("ownerId", event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>,
              )}
            </div>
            {field(
              "description",
              "Description (optional)",
              <textarea
                {...attributes("description")}
                value={values.description}
                onChange={(event) => update("description", event.target.value)}
                rows={3}
                maxLength={500}
                className={`${fieldClassName} resize-y`}
              />,
            )}
            {field(
              "tags",
              "Tags (optional)",
              <input
                {...attributes("tags", true)}
                value={values.tags}
                onChange={(event) => update("tags", event.target.value)}
                autoComplete="off"
                placeholder="checkout, web"
              />,
              "Separate tags with commas. Up to 20 tags, 40 characters each.",
            )}
          </fieldset>
          <p role="status" className="text-xs text-muted">
            {submitting
              ? "Creating flag… Keep this dialog open until the request finishes."
              : "Targeting and archive editing are not available in this phase."}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-5">
          <Button className="min-h-11 sm:min-h-9" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            className={primaryActionClassName}
            disabled={submitting}
          >
            {submitting ? (
              <LoaderCircle
                size={16}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {submitting ? "Creating…" : "Create flag"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
