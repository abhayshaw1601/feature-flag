import { createAuditHttpHandlers } from "@/lib/audit/http";
import { auditService } from "@/lib/audit/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 65;
export const POST = createAuditHttpHandlers(auditService).POST;
