import { createProjectFlagsHandlers } from "@/lib/flag-api";
import { createFlag, loadFlags } from "@/lib/flags";
import { auth } from "@/auth";
import { after } from "next/server";
import { queueCreatedFlagSummary } from "@/lib/audit/after-write";
import { enrichCreatedFlagAudit } from "@/lib/audit/runtime";

export const dynamic = "force-dynamic";
const handlers = createProjectFlagsHandlers({ createFlag, loadFlags });
export const GET = handlers.GET;
export const maxDuration = 65;
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const response = await handlers.POST(request, context);
  await queueCreatedFlagSummary(response, {
    getUserId: async () => (await auth())?.user?.id ?? null,
    schedule: after,
    enrich: enrichCreatedFlagAudit,
  });
  return response;
}
