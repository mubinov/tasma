import { isRecord } from "../format/values.js";
import { readRegularFile } from "./atomic.js";
import { causeOf } from "./errors.js";

/**
 * A JSON object file that the daemon keeps. A missing file is empty with no
 * fault. A file that cannot be used is empty, and `fault` says why.
 */
export async function readJsonObject(path: string): Promise<{ stored: Record<string, unknown>; fault?: string }> {
  let read;
  try {
    read = await readRegularFile(path);
  } catch (error) {
    return { stored: {}, fault: `this file cannot be read: ${causeOf(error)}` };
  }
  if (read === "absent") return { stored: {} };
  if (read === "irregular") return { stored: {}, fault: "this name holds no regular file" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch (error) {
    return { stored: {}, fault: `this file is not JSON: ${causeOf(error)}` };
  }
  if (!isRecord(parsed)) return { stored: {}, fault: "this file is not a JSON object" };
  return { stored: parsed };
}
