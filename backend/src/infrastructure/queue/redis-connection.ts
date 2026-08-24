import { Redis } from "ioredis";

import { env } from "../../config/env.js";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on any connection it manages internally
 * (its blocking commands rely on ioredis not giving up on them).
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
