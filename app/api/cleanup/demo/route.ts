import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cleanupThresholdsSchema,
  FixtureCandidateError,
  previewCleanupFixture,
  scanCleanupFixture,
} from "@/lib/cleanup/fixture";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const requestSchema = cleanupThresholdsSchema
  .extend({
    flagKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(80),
  })
  .strict();

function failure(error: unknown) {
  const status = error instanceof FixtureCandidateError ? 404 : 400;
  const message =
    error instanceof FixtureCandidateError
      ? error.message
      : "Use a known fixture flag and whole-day thresholds between 1 and 3650.";
  return NextResponse.json(
    { error: { code: "INVALID_FIXTURE_REQUEST", message } },
    { status, headers },
  );
}

// Deliberately public, synthetic-data-only endpoints. Never accept repository URLs,
// source code, workspace IDs or credentials here; live routes must enforce RBAC.
export function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const thresholds = cleanupThresholdsSchema.strict().parse(Object.fromEntries(query));
    return NextResponse.json({ data: scanCleanupFixture(thresholds) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    // Bound even chunked input before JSON parsing. Fixture requests are tiny.
    const reader = request.body?.getReader();
    if (!reader) return failure(null);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) {
        await reader.cancel();
        return NextResponse.json(
          { error: { code: "REQUEST_TOO_LARGE", message: "Fixture request is too large." } },
          { status: 413, headers },
        );
      }
      chunks.push(value);
    }
    const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return NextResponse.json({ data: previewCleanupFixture(input.flagKey, input) }, { headers });
  } catch (error) {
    return failure(error);
  }
}
