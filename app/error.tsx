"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function PageError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-[1200px] p-6">
      <section className="space-y-4 rounded-card border border-border bg-surface p-6" role="alert">
        <h1 className="text-2xl font-medium">Could not load this page</h1>
        <p className="text-sm text-muted">
          The saved data could not be loaded. Try again, or return to your flags.
        </p>
        <div className="flex items-center gap-4">
          <Button onClick={reset}>Retry</Button>
          <Link href="/" className="text-sm underline underline-offset-4">
            Back to flags
          </Link>
        </div>
      </section>
    </main>
  );
}
