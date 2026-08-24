import pino from "pino";

import { createLoggerOptions } from "../infrastructure/logger/logger.js";

/**
 * Entrypoint for the provisioning worker (tenant-provisioning queue consumer).
 *
 * Deliberately refuses to start: no real DatabaseProvisioner implementation exists yet —
 * creating a tenant's PostgreSQL database is out of scope for this task (see
 * ARCHITECTURE.md). All the surrounding infrastructure — the BullMQ Worker factory
 * (src/modules/provisioning/infrastructure/bullmq-provisioning-worker.ts), the persistence
 * repository, and the state machine use case — is implemented and covered by tests using a
 * fake DatabaseProvisioner. Only this production entrypoint is intentionally inert, so a
 * real deployment can never consume jobs and mark them SUCCEEDED without actually
 * provisioning anything.
 *
 * Wiring a real DatabaseProvisioner here (and removing this guard) is the natural next step
 * once one exists.
 */
const logger = pino(createLoggerOptions());

logger.fatal(
  { operation: "provisioning-worker.startup", reason: "no-database-provisioner-implementation" },
  "Refusing to start: no real DatabaseProvisioner implementation is wired in yet. See " +
    "src/modules/provisioning/application/process-provisioning-job.ts and ARCHITECTURE.md.",
);

process.exit(1);
