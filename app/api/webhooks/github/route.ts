import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Verifies GitHub webhook HMAC-SHA256 signature against GITHUB_WEBHOOK_SECRET.
 */
function verifyGitHubSignature(payload: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const hmac = crypto.createHmac("sha256", secret);
  const digest = `sha256=${hmac.update(payload).digest("hex")}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(digest));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    const event = request.headers.get("x-github-event");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    // If a webhook secret is configured, require valid signature
    if (secret && !verifyGitHubSignature(rawBody, signature, secret)) {
      return NextResponse.json(
        { error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature." } },
        { status: 401 },
      );
    }

    if (event === "ping") {
      return NextResponse.json({ ok: true, message: "pong" });
    }

    if (event !== "pull_request") {
      return NextResponse.json({ ok: true, message: `Ignored event: ${event}` });
    }

    const payload = JSON.parse(rawBody);
    const { action, pull_request } = payload;

    // Only process closed + merged PRs
    if (action !== "closed" || !pull_request?.merged) {
      return NextResponse.json({ ok: true, message: "PR not merged; no action taken." });
    }

    const branchName: string = pull_request.head?.ref ?? "";
    // Check if the PR branch was a flagforge cleanup branch: flagforge/cleanup-<flagKey>
    const match = /^flagforge\/cleanup-([a-z][a-z0-9_]*)$/.exec(branchName);
    if (!match) {
      return NextResponse.json({ ok: true, message: "Branch does not match cleanup naming convention." });
    }

    const flagKey = match[1];

    // Find and archive the flag in the database
    const flags = await prisma.flag.findMany({
      where: { key: flagKey, archivedAt: null },
      select: { id: true, projectId: true },
    });

    if (flags.length === 0) {
      return NextResponse.json({ ok: true, message: `No active flag found matching key ${flagKey}.` });
    }

    const now = new Date();
    for (const flag of flags) {
      await prisma.$transaction(async (tx) => {
        await tx.flag.update({
          where: { id: flag.id },
          data: { archivedAt: now },
        });

        await tx.auditEvent.create({
          data: {
            projectId: flag.projectId,
            flagId: flag.id,
            action: "FLAG_ARCHIVED",
            summary: `Automatically archived flag '${flagKey}' following merge of PR #${pull_request.number}.`,
            before: { archivedAt: null },
            after: { archivedAt: now.toISOString() },
          },
        });
      });
    }

    return NextResponse.json({
      data: {
        success: true,
        archivedCount: flags.length,
        flagKey,
        prNumber: pull_request.number,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "WEBHOOK_ERROR",
          message: error instanceof Error ? error.message : "Failed to process webhook.",
        },
      },
      { status: 500 },
    );
  }
}
