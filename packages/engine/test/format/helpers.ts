import { TaskParseError } from "@tasma/engine";

/** The parse fault of a call, or whatever else it raised, which is the test's own failure. */
function faultOf(error: unknown): TaskParseError {
  if (error instanceof TaskParseError) return error;
  throw error;
}

/** Runs a parse and returns the `TaskParseError` it must throw. */
export function parseFault(run: () => unknown, what: string): TaskParseError {
  try {
    run();
  } catch (error) {
    return faultOf(error);
  }
  throw new Error(`${what} did not throw`);
}

/** The same for a read that rejects rather than throwing as it stands. */
export async function parseRejection(run: () => Promise<unknown>, what: string): Promise<TaskParseError> {
  try {
    await run();
  } catch (error) {
    return faultOf(error);
  }
  throw new Error(`${what} did not throw`);
}
