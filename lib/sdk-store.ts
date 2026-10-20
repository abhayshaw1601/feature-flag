import { Prisma } from "@prisma/client";
import { serverFlagConfigSchema } from "@flagforge/contracts";
import { prisma } from "@/lib/prisma";
import { createDeliveryHandlers, type DeliveryStore } from "@/lib/sdk-delivery";

export const sdkStore: DeliveryStore = {
  async authenticate(hashedKey) {
    const key = await prisma.sdkKey.findUnique({
      where: { hashedKey },
      include: { environment: true },
    });
    if (!key || key.revokedAt) return null;
    const active = await prisma.sdkKey.updateMany({
      where: { id: key.id, revokedAt: null },
      data: { lastUsedAt: new Date() },
    });
    if (active.count !== 1) return null;
    return {
      id: key.id,
      type: key.type,
      environmentId: key.environmentId,
      environmentKey: key.environment.key,
    };
  },
  async flags(environmentId) {
    const records = await prisma.flagEnvironment.findMany({
      where: { environmentId, flag: { archivedAt: null } },
      include: { flag: true },
      orderBy: { flag: { key: "asc" } },
    });
    return records.map((config) =>
      serverFlagConfigSchema.parse({
        key: config.flag.key,
        type: config.flag.type,
        enabled: config.enabled,
        rules: config.rules,
        onValue: config.onValue,
        offValue: config.offValue,
        version: config.version,
      }),
    );
  },
  async ingest(key, events) {
    await prisma.$transaction(
      async (tx) => {
        // A revoke between initial authentication and ingestion must not insert events.
        const active = await tx.sdkKey.updateMany({
          where: { id: key.id, revokedAt: null },
          data: { lastUsedAt: new Date() },
        });
        if (!active.count) throw new Error("SDK key no longer active");
        const exposures = events.flatMap((event) =>
          event.kind === "exposure"
            ? [
                {
                  environmentId: key.environmentId,
                  flagKey: event.flagKey,
                  variation: event.variation,
                  userHash: event.userHash,
                  createdAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
                },
              ]
            : [],
        );
        const metrics = events.flatMap((event) =>
          event.kind === "metric"
            ? [
                {
                  environmentId: key.environmentId,
                  flagKey: event.flagKey,
                  variation: event.variation,
                  metric: event.metric,
                  value: event.value,
                  createdAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
                },
              ]
            : [],
        );
        if (exposures.length) await tx.exposureEvent.createMany({ data: exposures });
        if (metrics.length) await tx.metricEvent.createMany({ data: metrics });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },
};

export const sdkDelivery = createDeliveryHandlers(sdkStore);
