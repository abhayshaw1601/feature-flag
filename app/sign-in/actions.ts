"use server";

import { signIn } from "@/auth";

export async function startGithubSignIn() {
  await signIn("github", { redirectTo: "/" });
}
