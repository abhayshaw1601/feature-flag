import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["prisma", "validate"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgresql://flagforge:flagforge@localhost:5432/flagforge?schema=public",
    DIRECT_URL:
      process.env.DIRECT_URL ??
      "postgresql://flagforge:flagforge@localhost:5432/flagforge?schema=public",
  },
});

process.exit(result.status ?? 1);
