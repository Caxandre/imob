/** PostgreSQL SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

interface PostgresError {
  code: string;
  constraint?: string;
}

function hasPostgresErrorShape(value: unknown): value is Error & PostgresError {
  return value instanceof Error && typeof (value as Partial<PostgresError>).code === "string";
}

/**
 * Drizzle wraps driver errors, so the SQLSTATE code and constraint name live somewhere in the
 * `cause` chain rather than on the top-level error.
 */
function findPostgresError(error: unknown): PostgresError | undefined {
  let current: unknown = error;

  while (current instanceof Error) {
    if (hasPostgresErrorShape(current)) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

/** True when `error` is a unique violation raised by the given constraint. */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const postgresError = findPostgresError(error);

  return postgresError?.code === UNIQUE_VIOLATION && postgresError.constraint === constraintName;
}
