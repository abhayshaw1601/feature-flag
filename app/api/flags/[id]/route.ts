import { createFlagDetailHandler } from "@/lib/flag-api";
import { loadFlagDetail } from "@/lib/flags";

export const dynamic = "force-dynamic";
export const GET = createFlagDetailHandler({ loadFlagDetail });
