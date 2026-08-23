import { fileURLToPath } from "node:url";

// Resolved from this module rather than the process CWD so it holds both when running
// from src/ (tsx) and from dist/ — both sit four levels below the project root.
// Kept free of environment/pool imports so tooling can use it without booting the app config.
export const CONTROL_PLANE_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../../../drizzle/control-plane", import.meta.url),
);
