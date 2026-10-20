import { createAuditHttpHandlers } from "@/lib/audit/http";
import { auditService } from "@/lib/audit/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = createAuditHttpHandlers(auditService).GET;
