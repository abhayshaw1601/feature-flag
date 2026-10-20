import "server-only";

import { createEvaluationStore } from "./evaluation-store";
import { readEnvironment } from "./environment";

type Store = ReturnType<typeof createEvaluationStore>;
const server = globalThis as typeof globalThis & { __flagforgeExample?: Store };

export function evaluateUser(userId: string) {
  // One SDK client per Node process, including across development hot reloads.
  // Its cache, polling timer, and SSE connection outlive individual API requests.
  server.__flagforgeExample ??= createEvaluationStore({
    environment: readEnvironment(process.env),
    init: async (options) => {
      const { init } = await import("@flagforge/sdk");
      return init(options);
    },
  });
  return server.__flagforgeExample.evaluate(userId);
}
