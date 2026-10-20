import { Github } from "lucide-react";
import { startGithubSignIn } from "@/app/sign-in/actions";
import { Button } from "@/components/ui/button";

export default function SignInPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <section
        className="w-full max-w-[400px] rounded-card border border-border bg-surface p-8"
        aria-labelledby="sign-in-heading"
      >
        <div className="mb-8 flex items-center gap-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-control bg-accent text-white"
            aria-hidden="true"
          >
            <span className="text-sm font-medium">F</span>
          </span>
          <span className="text-base font-medium">FlagForge</span>
        </div>
        <h1 id="sign-in-heading" className="text-2xl font-medium tracking-[-0.02em]">
          Sign in to release safely
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Manage feature rollouts with your GitHub workspace and keep production changes visible.
        </p>
        <form className="mt-8" action={startGithubSignIn}>
          <Button className="w-full" variant="primary" size="md" type="submit">
            <Github size={17} aria-hidden="true" />
            Continue with GitHub
          </Button>
        </form>
      </section>
    </main>
  );
}
