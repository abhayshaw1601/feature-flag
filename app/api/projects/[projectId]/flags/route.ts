import { createProjectFlagsHandlers } from "@/lib/flag-api";
import { createFlag, loadFlags } from "@/lib/flags";

export const dynamic = "force-dynamic";
export const { GET, POST } = createProjectFlagsHandlers({ createFlag, loadFlags });
