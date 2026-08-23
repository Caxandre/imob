// Connection string used by Control Plane integration tests. It points at a dedicated
// database that the global setup drops and recreates on every run, so tests never touch
// the local development database. Local development credentials only — no real secrets.
export const CONTROL_PLANE_TEST_DATABASE_URL =
  process.env.CONTROL_PLANE_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5434/imob_control_test";
