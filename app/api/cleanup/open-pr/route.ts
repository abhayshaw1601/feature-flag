import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { previewCleanupFixture } from "@/lib/cleanup/fixture";

export const dynamic = "force-dynamic";

const openPrRequestSchema = z.object({
  flagKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "You must be signed in." } },
      { status: 401 },
    );
  }

  try {
    const json = await request.json();
    const { flagKey } = openPrRequestSchema.parse(json);
    const preview = previewCleanupFixture(flagKey);

    if (preview.review.status === "NEEDS_MANUAL_REVIEW") {
      return NextResponse.json(
        {
          error: {
            code: "MANUAL_REVIEW_REQUIRED",
            message: "This cleanup proposal requires manual review and cannot open an automated PR.",
          },
        },
        { status: 400 },
      );
    }

    // Return the generated branch, PR details, and confirmation link
    return NextResponse.json({
      data: {
        success: true,
        branchName: preview.branchName,
        prTitle: `Clean up stale flag: ${flagKey}`,
        prNumber: Math.floor(100 + Math.random() * 900),
        prUrl: `https://github.com/flagforge/demo-repo/pull/${Math.floor(100 + Math.random() * 900)}`,
        filesChanged: preview.review.files.length,
        explanation: preview.review.explanation,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : "Failed to open cleanup pull request.",
        },
      },
      { status: 400 },
    );
  }
}
