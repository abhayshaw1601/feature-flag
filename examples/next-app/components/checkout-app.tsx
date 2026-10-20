"use client";

import { AlertCircle, Flag, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  DEFAULT_USER_ID,
  SAMPLE_ATTRIBUTES,
  USER_ID_MAX_LENGTH,
  USER_ID_PATTERN,
  type Evaluation,
} from "../lib/evaluation";
import { CheckoutPreview } from "./checkout-preview";

const statusLabels: Record<Evaluation["status"], string> = {
  "configuration-error": "Environment setup needed",
  initializing: "Starting the server SDK",
  waiting: "Waiting for a cached flag",
  ready: "Reading the SDK cache",
  "sdk-error": "Using the safe default",
};

export function CheckoutApp() {
  const [userId, setUserId] = useState(DEFAULT_USER_ID);
  const [draftId, setDraftId] = useState(DEFAULT_USER_ID);
  const [inputError, setInputError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [requestError, setRequestError] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;

    async function refresh() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetch(`/api/evaluate?userId=${encodeURIComponent(userId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Evaluation request failed");
        const next: Evaluation = await response.json();
        if (
          next.userId !== userId ||
          typeof next.enabled !== "boolean" ||
          !(next.status in statusLabels)
        ) {
          throw new Error("Invalid evaluation response");
        }
        if (!stopped) {
          setEvaluation(next);
          setRequestError(false);
          setCheckedAt(new Date().toLocaleTimeString());
        }
      } catch {
        // Keep the last successful evaluation for this user when this app is unreachable.
        if (!stopped) setRequestError(true);
      } finally {
        clearTimeout(timeout);
        if (!stopped) {
          setRefreshing(false);
          timer = setTimeout(refresh, 1_000);
        }
      }
    }

    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [userId, retry]);

  function refreshNow() {
    setRefreshing(true);
    setRetry((value) => value + 1);
  }

  function applyUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!USER_ID_PATTERN.test(draftId)) {
      setInputError(
        "Enter 1–80 characters, starting with a letter or digit. Use only letters, digits, . _ : @ -",
      );
      return;
    }
    setInputError(null);
    if (draftId !== userId) {
      setEvaluation(null);
      setCheckedAt(null);
      setRequestError(false);
      setUserId(draftId);
    }
    refreshNow();
  }

  const enabled = evaluation?.enabled ?? false;
  const needsSetup = evaluation?.status === "configuration-error";
  const stateLabel = evaluation ? statusLabels[evaluation.status] : "Loading evaluation";

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to checkout preview
      </a>
      <header className="app-header frame">
        <div className="brand">
          <Flag size={20} strokeWidth={1.5} aria-hidden="true" />
          FlagForge
        </div>
        <span className="muted small">Customer app / Server-side SDK</span>
      </header>
      <main id="main" className="frame">
        <div className="title-row">
          <div>
            <h1>Checkout preview</h1>
            <p className="muted">One customer. A checkout that follows your flag.</p>
          </div>
          <button
            className="button secondary refresh-button"
            onClick={refreshNow}
            disabled={refreshing}
            aria-label={refreshing ? "Refreshing evaluation" : "Refresh evaluation"}
          >
            <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="refresh-label">
              {refreshing ? "Refreshing…" : "Refresh evaluation"}
            </span>
          </button>
        </div>

        <form className="customer-form" onSubmit={applyUser} noValidate>
          <div className="customer-field">
            <label htmlFor="user-id">Customer ID</label>
            <div className="input-action">
              <input
                id="user-id"
                name="userId"
                value={draftId}
                onChange={(event) => setDraftId(event.target.value)}
                maxLength={USER_ID_MAX_LENGTH}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(inputError)}
                aria-describedby={inputError ? "user-error" : "user-hint"}
              />
              <button className="button secondary" type="submit">
                Apply
              </button>
            </div>
            {inputError ? (
              <p id="user-error" className="field-error small" role="alert">
                {inputError}
              </p>
            ) : (
              <p id="user-hint" className="muted small">
                Change the ID to try a different rollout assignment.
              </p>
            )}
          </div>
          <p className="refresh-hint muted small">
            Refreshes every second from this app&apos;s server cache.
          </p>
        </form>

        <div className="workspace">
          <section className="evaluation-panel panel" aria-labelledby="evaluation-heading">
            <h2 id="evaluation-heading">Your evaluation</h2>
            <div className="evaluation-state" role="status" aria-live="polite" aria-atomic="true">
              <p className="flag-result" data-enabled={enabled}>
                <span className="status-dot" aria-hidden="true" />
                {enabled ? "Enabled" : "Off"}
              </p>
              <p>{enabled ? "Express checkout selected" : "Classic checkout selected"}</p>
              <p className="muted small">{stateLabel}</p>
            </div>

            {evaluation?.message && (
              <div className="notice" role={needsSetup ? "alert" : "status"}>
                <AlertCircle size={18} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  <p>{evaluation.message}</p>
                  {needsSetup && (
                    <p className="small muted">
                      See the example README for setup. Environment values are never shown here.
                    </p>
                  )}
                </div>
              </div>
            )}

            {requestError && (
              <div className="notice" role="alert">
                <AlertCircle size={18} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  <p>Could not refresh this app&apos;s evaluation.</p>
                  <p className="small muted">
                    {checkedAt
                      ? `Keeping the last result from ${checkedAt}.`
                      : "Showing the safe off default until a request succeeds."}
                  </p>
                  <button className="text-button" onClick={refreshNow}>
                    Retry now
                  </button>
                </div>
              </div>
            )}

            <dl className="context-list">
              <div>
                <dt>Evaluating user</dt>
                <dd>
                  <code>{userId}</code>
                </dd>
              </div>
              <div>
                <dt>Country</dt>
                <dd>{SAMPLE_ATTRIBUTES.country}</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{SAMPLE_ATTRIBUTES.plan}</dd>
              </div>
              <div>
                <dt>Evaluation source</dt>
                <dd>{evaluation?.source === "cache" ? "SDK cache" : "Safe default"}</dd>
              </div>
              <div>
                <dt>Browser checked</dt>
                <dd className="amount">{checkedAt ?? "Not yet"}</dd>
              </div>
            </dl>
            <p className="muted small cache-note">
              The server keeps its SDK cache during a FlagForge outage. This check time describes
              the browser request, not the control plane&apos;s health.
            </p>
          </section>

          <CheckoutPreview key={`${userId}-${enabled}`} enabled={enabled} />
        </div>
        <footer className="app-footer muted small">
          Change the configured flag in FlagForge to switch this checkout. The browser receives only
          the evaluation, never your SDK key or targeting rules.
        </footer>
        <noscript>
          <p className="notice">
            Enable JavaScript to refresh evaluations and use the checkout preview. The classic
            checkout is the safe default.
          </p>
        </noscript>
      </main>
    </>
  );
}
