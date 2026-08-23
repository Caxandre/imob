import { migrate } from "drizzle-orm/node-postgres/migrator";

import { controlPlaneDb, controlPlanePool } from "./client.js";
import { CONTROL_PLANE_MIGRATIONS_FOLDER } from "./migrations-folder.js";

// Explicit, standalone migration entrypoint. Never invoked by the API on startup:
// applying migrations and booting the application are independent operations.
try {
  await migrate(controlPlaneDb, { migrationsFolder: CONTROL_PLANE_MIGRATIONS_FOLDER });
} finally {
  await controlPlanePool.end();
}
