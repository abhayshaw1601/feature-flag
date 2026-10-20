"use client";

import { useState } from "react";

const environments = [
  { key: "development", label: "Development" },
  { key: "staging", label: "Staging" },
  { key: "production", label: "Production" },
] as const;

export function EnvironmentSwitcher() {
  const [selected, setSelected] = useState<(typeof environments)[number]["key"]>("staging");

  return (
    <div className="min-w-0 overflow-x-auto" aria-label="Environment" role="group">
      <div
        className="flex min-w-max rounded-control border border-border p-0.5"
        role="radiogroup"
        aria-label="Environment"
      >
        {environments.map((environment) => {
          const active = environment.key === selected;
          return (
            <button
              key={environment.key}
              className={`min-h-8 rounded-[6px] px-2.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-3 ${
                active
                  ? "bg-surface font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(environment.key)}
            >
              {environment.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
