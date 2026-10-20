import {
  auditQuerySchema,
  createFlagRequestSchema,
  listFlagsQuerySchema,
  type AuditQuery,
  type CreateFlagRequest,
  type ListFlagsQuery,
} from "@flagforge/contracts";
import { z } from "zod";

function queryObject(input: unknown): unknown {
  if (!(input instanceof URLSearchParams)) return input;
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of input) {
    if (Object.hasOwn(values, key)) {
      throw new z.ZodError([
        { code: "custom", path: [key], message: "Specify this query parameter only once." },
      ]);
    }
    values[key] = value;
  }
  return values;
}

function checkPaging(value: { page: number; pageSize: number }, context: z.RefinementCtx) {
  // Prisma's skip uses a signed 32-bit integer. Reject unsafe/overflowing offsets explicitly.
  if (!Number.isSafeInteger(value.page) || (value.page - 1) * value.pageSize > 2_147_483_647) {
    context.addIssue({ code: "custom", path: ["page"], message: "Page is out of range." });
  }
}

const listQuery = listFlagsQuerySchema.strict().superRefine(checkPaging);
const auditQuery = auditQuerySchema.strict().superRefine((value, context) => {
  checkPaging(value, context);
  if (!value.projectId && !value.flagId) {
    context.addIssue({
      code: "custom",
      path: ["projectId"],
      message: "Specify projectId or flagId to scope audit history.",
    });
  }
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "The end date must be on or after the start date.",
    });
  }
});

export function parseListFlagsQuery(input: unknown = {}): ListFlagsQuery {
  return listQuery.parse(queryObject(input));
}

export function parseAuditQuery(input: unknown): AuditQuery {
  return auditQuery.parse(queryObject(input));
}

export function parseCreateFlag(input: unknown): CreateFlagRequest {
  return createFlagRequestSchema.strict().parse(input);
}

export function parseFlagScopeId(input: string): string {
  return z.string().trim().min(1).parse(input);
}
