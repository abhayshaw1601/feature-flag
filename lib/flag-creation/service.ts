import { ruleSetSchema, type MemberRole } from "@flagforge/contracts";
import { FlagCreationError, flagCreationRequestSchema } from "./types";
import type { FlagCreationContext, FlagCreationRequest, FlagCreationResult } from "./types";
import { validateFlagCreationContext } from "./validation";

export class FlagPreviewError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FlagPreviewProject = {
  workspaceId: string;
  role: MemberRole;
  environments: Array<{ key: string; name: string }>;
  flags: Array<{ key: string; environments: Array<{ rules: unknown }> }>;
};

/** There is no attribute catalog yet: only attributes in this project's saved rules are known. */
export function contextForProject(
  project: FlagPreviewProject,
  allowProduction: boolean,
): FlagCreationContext {
  const attributes = new Set<string>();
  for (const flag of project.flags) {
    for (const environment of flag.environments) {
      const parsed = ruleSetSchema.safeParse(environment.rules);
      if (!parsed.success) throw new FlagCreationError("INVALID_CONTEXT");
      for (const rule of parsed.data.rules) {
        for (const condition of rule.conditions) attributes.add(condition.attribute);
      }
    }
  }
  return validateFlagCreationContext({
    existingFlagKeys: project.flags.map((flag) => flag.key),
    knownUserAttributes: [...attributes].sort(),
    environments: project.environments,
    allowProduction,
  });
}

export type FlagPreviewDependencies = {
  getUserId: () => Promise<string | null>;
  // Must filter by project AND membership before returning any context.
  loadProject: (projectId: string, userId: string) => Promise<FlagPreviewProject | null>;
  reserveRun: (input: {
    request: FlagCreationRequest;
    userId: string;
    workspaceId: string;
  }) => Promise<string>;
  completeRun: (runId: string, result: FlagCreationResult) => Promise<void>;
  failRun: (runId: string, code: string) => Promise<void>;
  generate: (input: {
    prompt: string;
    context: FlagCreationContext;
  }) => Promise<FlagCreationResult>;
};

async function readRequest(request: Request): Promise<unknown> {
  if (!request.body) throw new FlagPreviewError(400, "INVALID_REQUEST", "Provide a JSON request.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new FlagPreviewError(413, "REQUEST_TOO_LARGE", "The flag description is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof FlagPreviewError) throw error;
    throw new FlagPreviewError(400, "INVALID_REQUEST", "Provide a valid JSON request.");
  } finally {
    reader.releaseLock();
  }
}

/** Preview-only: this handler has no flag-write dependency and never applies targeting. */
export function createFlagPreviewHandler(deps: FlagPreviewDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const headers = { "Cache-Control": "private, no-store" };
    let runId: string | undefined;
    try {
      const userId = await deps.getUserId();
      if (!userId)
        throw new FlagPreviewError(401, "UNAUTHENTICATED", "Sign in to generate a flag preview.");
      const parsed = flagCreationRequestSchema.safeParse(await readRequest(request));
      if (!parsed.success) throw new FlagCreationError("INVALID_REQUEST");
      const input = parsed.data;
      const project = await deps.loadProject(input.projectId, userId);
      if (!project)
        throw new FlagPreviewError(404, "PROJECT_NOT_FOUND", "The project was not found.");
      if (project.role === "VIEWER")
        throw new FlagPreviewError(403, "FORBIDDEN", "Generating flags requires editor access.");
      const context = contextForProject(project, input.allowProduction);
      runId = await deps.reserveRun({ request: input, userId, workspaceId: project.workspaceId });
      const result = await deps.generate({ prompt: input.prompt, context });
      await deps.completeRun(runId, result);
      return Response.json(
        {
          data: { draft: result.draft, model: result.model, mock: result.mock, previewOnly: true },
        },
        { headers },
      );
    } catch (error) {
      const known = error instanceof FlagCreationError || error instanceof FlagPreviewError;
      const code = known ? error.code : "INTERNAL_ERROR";
      if (runId) {
        // Logging failures must not leak provider bodies, project data, or credentials.
        await deps.failRun(runId, code).catch(() => undefined);
      }
      return Response.json(
        {
          error: {
            code,
            message: known ? error.message : "The preview could not be generated. Please retry.",
          },
        },
        { status: known ? error.status : 500, headers },
      );
    }
  };
}
