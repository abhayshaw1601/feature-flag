import { sdkDelivery } from "@/lib/sdk-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = sdkDelivery.stream;
export const OPTIONS = sdkDelivery.options;
