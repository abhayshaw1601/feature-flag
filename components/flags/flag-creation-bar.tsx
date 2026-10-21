"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import { apiErrorSchema } from "@flagforge/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FlagCreationPreviewDrawer } from "./flag-creation-preview";
import {
  flagCreationPreviewResponseSchema,
  previewText,
  type FlagCreationPreview,
} from "./flag-creation-preview-data";

const examples = [
  "Roll out new checkout to 10% of users in India on the pro plan, staging first.",
  "Kill switch for payments",
] as const;

export type FlagCreationBarProps = {
  projectId?: string;
  canGenerate?: boolean;
  environments?: ReadonlyArray<{ key: string; name: string }>;
  /** Public demo uses local fixtures only; never changes auth on the real endpoint. */
  demo?: boolean;
};

// A context change discards drafts and aborts the previous scope's request.
export function FlagCreationBar({
  projectId,
  canGenerate = false,
  environments = [],
  demo = false,
}: FlagCreationBarProps) {
  const scope = projectId?.trim();
  return (
    <FlagCreationForm
      key={JSON.stringify([scope, canGenerate, demo])}
      projectId={scope}
      canGenerate={canGenerate}
      environments={environments}
      demo={demo}
    />
  );
}

function FlagCreationForm({
  projectId,
  canGenerate,
  environments = [],
  demo = false,
}: FlagCreationBarProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<{ controller: AbortController; timeoutId: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [allowProduction, setAllowProduction] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FlagCreationPreview | null>(null);
  const unavailable = !projectId || !canGenerate;
  const disabledReason = [
    !projectId ? "Select a project to generate a preview; project context is required." : "",
    !canGenerate ? "Generation requires editor access or higher. Viewer access is read-only." : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    return () => {
      const request = requestRef.current;
      requestRef.current = null;
      if (request) {
        window.clearTimeout(request.timeoutId);
        request.controller.abort();
      }
    };
  }, []);

  function invalidateRequest() {
    const request = requestRef.current;
    requestRef.current = null;
    if (request) {
      window.clearTimeout(request.timeoutId);
      request.controller.abort();
    }
    setLoading(false);
    setError(null);
    setPreview(null);
  }

  function changePrompt(value: string) {
    invalidateRequest();
    setPrompt(value);
  }

  async function generate() {
    if (unavailable || !prompt.trim() || requestRef.current) return;
    setError(null);
    setPreview(null);
    setLoading(true);
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : textareaRef.current;
    const request = { controller: new AbortController(), timeoutId: 0 };
    requestRef.current = request;
    // Leave time for authorization/logging around the server's 30-second generation deadline.
    request.timeoutId = window.setTimeout(() => {
      if (requestRef.current !== request) return;
      requestRef.current = null;
      request.controller.abort();
      setLoading(false);
      setError("Preview generation timed out after 70 seconds. Please retry.");
    }, 70_000);

    try {
      const response = demo
        ? await fixtureResponse()
        : await fetch("/api/ai/flag-creation", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ projectId, prompt: prompt.trim(), allowProduction }),
            signal: request.controller.signal,
          });
      const body: unknown = await response.json().catch(() => null);
      const apiError = apiErrorSchema.safeParse(body);
      if (apiError.success) throw new Error(apiError.data.error.message);
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Preview generation is unavailable. The flag-creation endpoint may not be ready yet."
            : `Could not generate a preview (HTTP ${response.status}). Please retry.`,
        );
      }
      const result = flagCreationPreviewResponseSchema.safeParse(body);
      if (!result.success)
        throw new Error("The response was not a valid preview-only flag draft. Please retry.");
      if (
        !allowProduction &&
        result.data.data.draft.environments.some(
          (environment) =>
            environment.environmentKey.trim().toLowerCase() === "production" && environment.enabled,
        )
      ) {
        throw new Error(
          "The draft enabled Production without your explicit request. Please revise the request or retry.",
        );
      }
      if (requestRef.current === request && !request.controller.signal.aborted) {
        setPreview(result.data.data);
      }
    } catch (cause) {
      if (requestRef.current === request && !request.controller.signal.aborted) {
        setError(
          cause instanceof Error && !(cause instanceof TypeError)
            ? previewText(cause.message) || "Could not generate a preview. Please retry."
            : "Could not reach the preview service. Check your connection and retry.",
        );
      }
    } finally {
      window.clearTimeout(request.timeoutId);
      if (requestRef.current === request) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void generate();
  }

  async function fixtureResponse(): Promise<Response> {
    const { generateMockFlagDraft } = await import("@/lib/flag-creation/fixtures");
    const draft = generateMockFlagDraft(prompt.trim(), {
      existingFlagKeys: [],
      knownUserAttributes: ["country", "plan", "isInternal"],
      environments: [...environments],
      allowProduction,
    });
    return Response.json({
      data: { draft, model: "mock:flag-creation.v1", mock: true, previewOnly: true },
    });
  }

  return (
    <section
      className="min-w-0 rounded-card border border-accent bg-surface p-4 sm:p-5"
      aria-labelledby={`${id}-heading`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-base font-medium">
          <label htmlFor={`${id}-prompt`}>Describe a flag in plain English</label>
        </h2>
        <Badge>Preview only</Badge>
      </div>
      <p id={`${id}-help`} className="mt-2 text-sm text-muted">
        Generate a draft to review its targeting, assumptions, and warnings. Nothing is saved.
      </p>
      {demo ? (
        <p className="mt-2 text-sm text-muted">
          Local fixture demo: use an example sentence. No AI provider or database is contacted.
        </p>
      ) : null}
      {unavailable ? (
        <p id={`${id}-unavailable`} className="mt-3 text-sm text-muted">
          {disabledReason}
        </p>
      ) : null}
      <form onSubmit={submit} className="mt-4 space-y-4">
        <textarea
          ref={textareaRef}
          id={`${id}-prompt`}
          name="flag-request"
          className="min-h-28 w-full min-w-0 resize-y rounded-control border border-[var(--border-strong)] bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
          rows={3}
          placeholder="Describe the feature, audience, rollout, and environment…"
          aria-describedby={`${id}-help${unavailable ? ` ${id}-unavailable` : ""}`}
          value={prompt}
          disabled={unavailable}
          required
          minLength={10}
          maxLength={2000}
          onChange={(event) => changePrompt(event.target.value)}
        />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Example flag requests">
          {examples.map((example) => (
            <Button
              key={example}
              size="sm"
              className="min-h-9 max-w-full whitespace-normal py-2 text-left text-xs"
              disabled={unavailable}
              onClick={() => {
                changePrompt(example);
                textareaRef.current?.focus();
              }}
            >
              {example}
            </Button>
          ))}
        </div>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm" htmlFor={`${id}-production`}>
            <input
              id={`${id}-production`}
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              checked={allowProduction}
              disabled={unavailable}
              aria-describedby={`${id}-production-help`}
              onChange={(event) => {
                invalidateRequest();
                setAllowProduction(event.target.checked);
              }}
            />
            Explicitly ask to allow Production in this draft
          </label>
          <p id={`${id}-production-help`} className="text-xs text-muted">
            Off by default. The server forbids enabling Production unless you check this box. Also
            explicitly request Production in your description. Checking this box does not approve or
            apply any change.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            className="min-h-11"
            disabled={unavailable || !prompt.trim() || loading}
            aria-describedby={unavailable ? `${id}-unavailable` : undefined}
          >
            {loading ? (
              <LoaderCircle
                size={16}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Sparkles size={16} aria-hidden="true" />
            )}
            {loading ? "Generating preview…" : "Generate preview"}
          </Button>
          {loading ? (
            <Button className="min-h-11" onClick={invalidateRequest}>
              Cancel generation
            </Button>
          ) : null}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {loading ? (
            <div className="space-y-3 rounded-control border border-border bg-background p-4">
              <p className="text-sm text-muted">
                Preparing and validating your draft. This can take up to a minute. Editing the
                request cancels this preview.
              </p>
              <div className="space-y-2 motion-safe:animate-pulse" aria-hidden="true">
                <span className="skeleton block h-4 w-2/3" />
                <span className="skeleton block h-4 w-full" />
                <span className="skeleton block h-4 w-1/2" />
              </div>
            </div>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-danger bg-background p-3"
          >
            <p className="min-w-0 flex-1 basis-60 whitespace-pre-wrap break-words text-sm">
              {error}
            </p>
            <Button
              className="min-h-11"
              disabled={unavailable || !prompt.trim() || loading}
              onClick={() => void generate()}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </form>
      {preview ? (
        <FlagCreationPreviewDrawer
          preview={preview}
          projectId={projectId}
          environments={environments}
          allowProduction={allowProduction}
          returnFocusRef={returnFocusRef}
          editTargetRef={textareaRef}
          onDismiss={() => setPreview(null)}
          onSuccess={() => {
            setPrompt("");
            setPreview(null);
          }}
        />
      ) : null}
    </section>
  );
}
