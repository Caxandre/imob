import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { CONTROL_PLANE_MIGRATIONS_FOLDER } from "../src/infrastructure/database/control-plane/migrations-folder.js";
import { CONTROL_PLANE_TEST_DATABASE_URL } from "./control-plane-test-db.js";

const SAFE_DATABASE_NAME = /^[a-zA-Z0-9_]+$/;

/**
 * Recreates the Control Plane test database from scratch and applies every migration to it,
 * so each run exercises the real "empty database -> migrations -> complete schema" path.
 *
 * Requires the local `postgres-control` service to be running (`docker compose up -d`).
 */
export async function setup() {
  const testUrl = new URL(CONTROL_PLANE_TEST_DATABASE_URL);
  const databaseName = testUrl.pathname.slice(1);

  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }

  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = "/postgres";

  const maintenancePool = new Pool({ connectionString: maintenanceUrl.toString() });
  try {
    // FORCE terminates leftover connections from an interrupted previous run.
    await maintenancePool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenancePool.end();
  }

  const migrationPool = new Pool({ connectionString: CONTROL_PLANE_TEST_DATABASE_URL });
  try {
    await migrate(drizzle(migrationPool), {
      migrationsFolder: CONTROL_PLANE_MIGRATIONS_FOLDER,
    });
  } finally {
    await migrationPool.end();
  }
}
