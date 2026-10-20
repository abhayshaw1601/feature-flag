import type { RolloutState } from "@/lib/auto-rollout/types";
import { formatVirtualTime } from "./monitor-format";

export function RolloutActivity({ state }: { state: RolloutState }) {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <section
        className="min-w-0 rounded-card border border-border p-4 sm:p-5"
        aria-labelledby="audit-title"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="audit-title" className="text-base font-medium">
            Browser-only audit log
          </h2>
          <span className="num text-xs text-muted">{state.audit.length} events</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Local simulation events. Cleared on reset or reload.
        </p>
        {state.audit.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            No changes yet. Starting a ramp creates the first audit event.
          </p>
        ) : (
          <ol
            className="mt-3 max-h-72 space-y-4 overflow-y-auto pr-1"
            aria-label="Audit events, newest first"
          >
            {state.audit
              .slice()
              .reverse()
              .map((event) => (
                <li key={event.id} className="break-words text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{event.actor}</span>
                    <span className="num text-xs text-muted">
                      {formatVirtualTime(event.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1">{event.summary}</p>
                  <p className="num mt-1 text-xs text-muted">
                    {event.before.enabled ? "On" : "Off"} at {event.before.rolloutPercent}% to{" "}
                    {event.after.enabled ? "on" : "off"} at {event.after.rolloutPercent}%
                  </p>
                </li>
              ))}
          </ol>
        )}
      </section>
      <section
        className="min-w-0 rounded-card border border-border p-4 sm:p-5"
        aria-labelledby="notifications-title"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="notifications-title" className="text-base font-medium">
            Demo notifications
          </h2>
          <span className="num text-xs text-muted">{state.notifications.length} messages</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Browser-only messages. No email, Slack, or webhook is sent.
        </p>
        {state.notifications.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            No notifications yet. Messages from the rollout engine appear here.
          </p>
        ) : (
          <ol
            className="mt-3 max-h-72 space-y-4 overflow-y-auto pr-1"
            aria-label="Notifications, newest first"
          >
            {state.notifications
              .slice()
              .reverse()
              .map((notification) => (
                <li key={notification.id} className="break-words text-sm">
                  <span className="num text-xs text-muted">
                    {formatVirtualTime(notification.at)}
                  </span>
                  <p className="mt-1">{notification.message}</p>
                </li>
              ))}
          </ol>
        )}
      </section>
    </div>
  );
}
