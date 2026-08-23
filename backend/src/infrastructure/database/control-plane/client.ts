import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "../../../config/env.js";
import * as schema from "./schema.js";

export const controlPlanePool = new Pool({
  connectionString: env.CONTROL_PLANE_DATABASE_URL,
});

export const controlPlaneDb = drizzle(controlPlanePool, { schema });

export type ControlPlaneDatabase = typeof controlPlaneDb;
