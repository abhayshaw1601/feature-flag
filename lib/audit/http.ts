import { AuditAccessError, auditErrorResponse, type createAuditService } from "./service";

export function createAuditHttpHandlers(service: ReturnType<typeof createAuditService>) {
  const headers = { "Cache-Control": "private, no-store" };
  return {
    async GET(request: Request) {
      try {
        return Response.json(
          { data: await service.overview(new URL(request.url).searchParams) },
          { headers },
        );
      } catch (error) {
        return auditErrorResponse(error);
      }
    },
    async POST(request: Request) {
      try {
        const origin = request.headers.get("origin");
        if (origin && origin !== new URL(request.url).origin)
          throw new AuditAccessError(403, "CROSS_ORIGIN", "Cross-origin requests are not allowed.");
        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          throw new AuditAccessError(415, "CONTENT_TYPE", "Send an application/json request.");
        const reader = request.body?.getReader();
        if (!reader) throw new SyntaxError("Missing body");
        let bytes = 0;
        let text = "";
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { value, done } = await reader.read();
            bytes += value?.byteLength ?? 0;
            if (bytes > 8192)
              throw new AuditAccessError(
                413,
                "BODY_TOO_LARGE",
                "Select no more than 20 audit events.",
              );
            text += decoder.decode(value, { stream: !done });
            if (done) break;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const result = await service.summarize(JSON.parse(text), request.signal);
        return Response.json({ data: result }, { headers });
      } catch (error) {
        return auditErrorResponse(error);
      }
    },
  };
}
