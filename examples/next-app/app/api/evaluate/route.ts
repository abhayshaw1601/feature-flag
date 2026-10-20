import { evaluateRequest } from "../../../lib/evaluate-request";
import { evaluateUser } from "../../../lib/flagforge.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(request: Request) {
  return evaluateRequest(request, evaluateUser);
}
