"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Info, Sparkles, X } from "lucide-react";
import { AiError } from "@/components/ai/ai-error";
import { AiFeedback, type AiFeedbackValue } from "@/components/ai/ai-feedback";
import { AiLoading } from "@/components/ai/ai-loading";
import { AiPanel } from "@/components/ai/ai-panel";
import { Button } from "@/components/ui/button";
import { AiTestError, requestAiTest, type AiTestResult } from "./ai-test-client";

type DemoState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: AiTestResult }
  | { status: "error"; error: string; submittedMessage: string };

export function AiDemo({
  workspaceId,
  workspaceName,
}: Readonly<{ workspaceId: string; workspaceName: string }>) {
  const [message, setMessage] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [state, setState] = useState<DemoState>({ status: "idle" });
  const [feedback, setFeedback] = useState<AiFeedbackValue>(null);
  const [notice, setNotice] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const pending = state.status === "loading";

  useEffect(() => {
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  async function run(input: string) {
    // The ref also blocks a second submit before React has rendered the disabled controls.
    if (activeRequest.current) return;
    const submittedMessage = input.trim();
    if (!submittedMessage) {
      setInputError("Enter a message to test the AI platform.");
      messageInput.current?.focus();
      return;
    }

    const controller = new AbortController();
    activeRequest.current = controller;
    setInputError(null);
    setNotice("");
    setFeedback(null);
    setState({ status: "loading" });

    // Allow time for server-side validation/retry, but never leave the form locked indefinitely.
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90_000);

    try {
      const result = await requestAiTest(workspaceId, submittedMessage, controller.signal);
      if (activeRequest.current === controller && !controller.signal.aborted) {
        setState({ status: "success", result });
        setNotice("Validated AI response ready.");
      }
    } catch (error) {
      if (activeRequest.current !== controller) return;
      setState({
        status: "error",
        submittedMessage,
        error: timedOut
          ? "The AI request took too long. Please try again."
          : error instanceof AiTestError
            ? error.message
            : "Could not complete the AI request. Please try again.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(message);
  }

  function dismiss() {
    setState({ status: "idle" });
    setFeedback(null);
    setNotice("Response dismissed.");
    messageInput.current?.focus();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="text-sm text-muted">AI platform</p>
        <h1 className="mt-1 text-2xl font-medium tracking-[-0.02em]">Test the AI platform</h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Send a single message to check structured AI output for {workspaceName}. This demo
          generates a response only.
        </p>
      </header>

      <form
        onSubmit={submit}
        aria-label="Test the AI platform"
        aria-busy={pending}
        className="rounded-card border border-border bg-surface p-5 sm:p-6"
      >
        <label htmlFor="ai-message" className="block text-sm font-medium">
          Message
        </label>
        <p id="ai-message-help" className="mt-1 text-xs leading-5 text-muted">
          Model selection and mock mode are configured on the server.
        </p>
        <textarea
          ref={messageInput}
          id="ai-message"
          name="message"
          rows={4}
          maxLength={4000}
          required
          value={message}
          disabled={pending}
          aria-invalid={Boolean(inputError)}
          aria-describedby={`ai-message-help${inputError ? " ai-message-error" : ""}`}
          placeholder="Describe what you would like the AI platform to summarize."
          className="mt-3 block w-full resize-y rounded-control border border-border bg-background px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          onChange={(event) => {
            setMessage(event.target.value);
            setInputError(null);
          }}
        />
        {inputError ? (
          <p id="ai-message-error" role="alert" className="mt-2 text-sm text-danger">
            {inputError}
          </p>
        ) : null}
        <Button className="mt-4" type="submit" variant="primary" disabled={pending}>
          <Sparkles size={15} aria-hidden="true" />
          {pending ? "Generating…" : "Generate response"}
        </Button>
      </form>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {notice}
      </p>
      {state.status === "idle" ? (
        <p className="text-sm text-muted">Submit a message to see a validated response.</p>
      ) : null}
      {pending ? <AiLoading /> : null}
      {state.status === "error" ? (
        <div className="space-y-2">
          <AiError message={state.error} onRetry={() => void run(state.submittedMessage)} />
          <p className="text-xs text-muted">Retry resends your last submitted message.</p>
        </div>
      ) : null}
      {state.status === "success" ? (
        <AiPanel
          title="Validated response"
          model={state.result.model}
          mock={state.result.mock}
          actions={
            <div className="flex flex-wrap items-start justify-between gap-4">
              <AiFeedback value={feedback} onChange={setFeedback} />
              <Button onClick={dismiss}>
                <X size={15} aria-hidden="true" />
                Dismiss
              </Button>
            </div>
          }
        >
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {state.result.output.message.trim()
              ? state.result.output.message
              : "The model returned an empty message."}
          </p>
          {state.result.output.insufficientData ? (
            <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-muted">
              <Info size={16} className="mt-1 shrink-0 text-warning" aria-hidden="true" />
              Insufficient data: the model reported that it needs more context.
            </p>
          ) : null}
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-xs sm:grid-cols-3">
            <div className="col-span-2 min-w-0 sm:col-span-3">
              <dt className="text-muted">Run ID</dt>
              <dd className="mt-1 break-all font-mono">{state.result.runId}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted">Prompt version</dt>
              <dd className="mt-1 break-all font-mono">{state.result.promptVersion}</dd>
            </div>
            <div>
              <dt className="text-muted">Tokens in / out</dt>
              <dd className="mt-1 font-mono">
                {state.result.tokensIn} / {state.result.tokensOut}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Latency</dt>
              <dd className="mt-1 font-mono">{state.result.latencyMs} ms</dd>
            </div>
          </dl>
        </AiPanel>
      ) : null}
    </div>
  );
}
