import { readRiskRequest, riskErrorResponse, riskResponse } from "@/lib/rollout-risk/http";
import { createRiskService } from "@/lib/rollout-risk/service";
import { rolloutRiskInputSchema } from "@/lib/rollout-risk/types";

export const runtime = "nodejs";
const demo = createRiskService({ env: { AI_MOCK: "true" } });

/** Public fixture-only assessment: never calls a model, database, or write API. */
export async function POST(request: Request) {
  try {
    const input = rolloutRiskInputSchema.parse(await readRiskRequest(request));
    input.actorId = "demo-operator";
    return riskResponse(
      await demo.assess(input, {
        workspaceId: "demo",
        actorId: input.actorId,
        changeId: "fixture",
      }),
    );
  } catch (error) {
    return riskErrorResponse(error);
  }
}
