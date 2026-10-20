import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadRiskContext } from "@/lib/rollout-risk/context";
import { readRiskRequest, riskErrorResponse, riskResponse } from "@/lib/rollout-risk/http";
import { createRiskService, RolloutRiskError } from "@/lib/rollout-risk/service";
import { rolloutRiskRequestSchema } from "@/lib/rollout-risk/types";

export const runtime = "nodejs";
const service = createRiskService({
  record: async (scope, run) => {
    await prisma.aiRun.create({
      data: {
        workspaceId: scope.workspaceId,
        feature: "ROLLOUT_RISK",
        // A stable pointer, not raw targeting values or user attributes.
        input: { changeId: scope.changeId, promptVersion: "rollout-risk.v1" },
        output: run.result.assessment,
        model: run.result.model,
        latencyMs: run.latencyMs,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        status: run.result.source === "fallback" ? "FAILED" : "SUCCEEDED",
        error: run.result.source === "fallback" ? "GENERATION_UNAVAILABLE" : null,
      },
    });
  },
});

/** Advisory only. This endpoint does not save flag targeting or authorize a future write. */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      throw new RolloutRiskError(401, "UNAUTHENTICATED", "Sign in to assess a flag change.");
    const body = rolloutRiskRequestSchema.parse(await readRiskRequest(request));
    const { input, scope } = await loadRiskContext(prisma, session.user.id, body);
    return riskResponse(await service.assess(input, scope));
  } catch (error) {
    return riskErrorResponse(error);
  }
}
