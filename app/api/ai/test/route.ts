import { getAiConfig } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { promptRegistry } from "@/lib/ai/prompts";
import { runAi } from "@/lib/ai/runner";
import { createPrismaAiRunStore } from "@/lib/ai/store";
import { createAiTestHandler } from "@/lib/ai/test-handler";
import { prisma } from "@/lib/prisma";
import { AuthorizationError, requireWorkspaceMember } from "@/lib/workspace-auth";

export const runtime = "nodejs";
export const maxDuration = 65;

export const POST = createAiTestHandler({
  async authorize(workspaceId) {
    try {
      const { session } = await requireWorkspaceMember(workspaceId);
      return { userId: session.user.id };
    } catch (error) {
      if (error instanceof AuthorizationError)
        throw new AiError("AUTHORIZATION_REQUIRED", error.message, error.status);
      throw error;
    }
  },
  run(input, userId, signal) {
    return runAi({
      context: { workspaceId: input.workspaceId, userId },
      prompt: promptRegistry["platform-test@1"],
      input: { message: input.message },
      logInput: { messageLength: input.message.length },
      config: getAiConfig(),
      store: createPrismaAiRunStore(prisma),
      signal,
    });
  },
});
