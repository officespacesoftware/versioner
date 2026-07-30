/**
 * Raised when the flags a command was given cannot be satisfied — a
 * contradiction the operator has to resolve, never an environment fault.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
