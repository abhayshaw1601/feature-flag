/** Queue derived summaries only after a successful ordinary audited flag creation. */
export async function queueCreatedFlagSummary(
  response: Response,
  deps: {
    getUserId(): Promise<string | null>;
    schedule(task: () => Promise<void>): void;
    enrich(flagId: string, userId: string): Promise<void>;
  },
): Promise<void> {
  if (response.status !== 201) return;
  try {
    const body: unknown = await response.clone().json();
    const id = (body as { data?: { id?: unknown } })?.data?.id;
    if (typeof id !== "string" || !id) return;
    const userId = await deps.getUserId();
    if (!userId) return;
    deps.schedule(async () => {
      try {
        await deps.enrich(id, userId);
      } catch {
        // Durable fallback remains. Retry explicitly from the Audit page if enrichment fails.
      }
    });
  } catch {
    // A scheduling failure must not change a committed flag creation into an error response.
  }
}
