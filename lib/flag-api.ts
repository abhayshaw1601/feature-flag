import { ZodError } from "zod";
import { FlagServiceError } from "./flag-errors";
import type { FlagService } from "./flag-service";

const privateHeaders = { "Cache-Control": "private, no-store" };

/** Maps only expected client errors; internal failures never echo/log data or database details. */
async function respond(work: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return Response.json({ data: await work() }, { status, headers: privateHeaders });
  } catch (error) {
    if (error instanceof FlagServiceError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          },
        },
        { status: error.status, headers: privateHeaders },
      );
    }
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Check the highlighted fields.",
            fieldErrors: error.flatten().fieldErrors,
          },
        },
        { status: 400, headers: privateHeaders },
      );
    }
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } },
      { status: 500, headers: privateHeaders },
    );
  }
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FlagServiceError(400, "MALFORMED_JSON", "Request body must be valid JSON.");
    }
    throw error;
  }
}

/** Injectable handlers keep offline tests on the same HTTP/service path as the Next.js routes. */
export function createProjectFlagsHandlers(service: Pick<FlagService, "loadFlags" | "createFlag">) {
  type Context = { params: Promise<{ projectId: string }> };
  return {
    GET(request: Request, context: Context) {
      return respond(async () => {
        const { projectId } = await context.params;
        return service.loadFlags(projectId, new URL(request.url).searchParams);
      });
    },
    POST(request: Request, context: Context) {
      return respond(async () => {
        const { projectId } = await context.params;
        return service.createFlag(projectId, await jsonBody(request));
      }, 201);
    },
  };
}

export function createFlagDetailHandler(service: Pick<FlagService, "loadFlagDetail">) {
  return (_request: Request, context: { params: Promise<{ id: string }> }) =>
    respond(async () => service.loadFlagDetail((await context.params).id));
}

export function createAuditHandler(service: Pick<FlagService, "loadAudit">) {
  return (request: Request) => respond(() => service.loadAudit(new URL(request.url).searchParams));
}
