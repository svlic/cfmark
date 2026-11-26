// Isolated, loopback-only test server. These credentials are synthetic fixtures, never deployment defaults.
import { spawnSync, spawn } from "node:child_process";
const result = spawnSync(
  "npx",
  [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    ".amp/in/e2e-db",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status || 1);
const server = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--persist-to",
    ".amp/in/e2e-db",
    "--var",
    "ADMIN_USERNAME:browser-test",
    "--var",
    "ADMIN_PASSWORD:synthetic-browser-test-only-2026",
  ],
  { stdio: "inherit" },
);
server.on("exit", (code) => process.exit(code || 0));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
