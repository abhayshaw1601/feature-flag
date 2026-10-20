import { createAuditHandler } from "@/lib/flag-api";
import { loadAudit } from "@/lib/flags";

export const dynamic = "force-dynamic";
export const GET = createAuditHandler({ loadAudit });
