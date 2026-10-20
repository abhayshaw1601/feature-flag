import { DEFAULT_USER_ID, USER_ID_PATTERN, type Evaluation } from "./evaluation";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

export function evaluateRequest(request: Request, evaluate: (userId: string) => Evaluation) {
  const ids = new URL(request.url).searchParams.getAll("userId");
  const userId = ids[0] ?? DEFAULT_USER_ID;
  if (ids.length > 1 || !USER_ID_PATTERN.test(userId)) {
    return Response.json(
      {
        error: {
          code: "INVALID_USER_ID",
          message:
            "Use a 1–80 character user ID, starting with a letter or digit. Allowed punctuation: . _ : @ -",
        },
      },
      { status: 400, headers },
    );
  }

  try {
    return Response.json(evaluate(userId), { headers });
  } catch {
    return Response.json(
      {
        error: {
          code: "EVALUATION_UNAVAILABLE",
          message: "Evaluation is unavailable. Retry shortly.",
        },
      },
      { status: 503, headers },
    );
  }
}
