import { DEFAULT_DAEMON_PORT } from "@tasma/protocol";

/** A run of decimal digits and nothing else: no sign, no point, no surrounding space. */
const DIGITS = /^\d+$/;

const HIGHEST_PORT = 65535;

/** Whether a value is a port number: the rule the flag, the variable and the record are all read by. */
export function isPortNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= HIGHEST_PORT;
}

/** What a channel states, or nothing where it states nothing, so precedence reads as the order of two calls. */
function stated(channel: string, value: string | undefined): { channel: string; value: string } | undefined {
  return value === undefined || value === "" ? undefined : { channel, value };
}

/**
 * Which port to bind: the flag, then `TASMA_DAEMON_PORT`, then the built-in
 * default. Both channels arrive as parameters, so nothing below the entry point
 * reads a global, and a bad value is refused the same way whichever stated it.
 *
 * An empty value is no value: an exported-but-empty variable is an ordinary
 * shell and CI shape, and refusing it would name no port to act on.
 *
 * Zero is a port like any other. It asks the operating system for a free one,
 * and the record then carries the number it chose.
 */
export function resolveDaemonPort(flag: string | undefined, env: Record<string, string | undefined>): number {
  const source = stated("--port", flag) ?? stated("TASMA_DAEMON_PORT", env.TASMA_DAEMON_PORT);

  if (source === undefined) {
    return DEFAULT_DAEMON_PORT;
  }

  const port = DIGITS.test(source.value) ? Number(source.value) : Number.NaN;

  if (!isPortNumber(port)) {
    // Quoted as a JSON string, so the value is delimited from the sentence and a
    // break inside it is shown rather than run through the message.
    throw new Error(`${source.channel} must be a whole number from 0 to ${HIGHEST_PORT}: ${JSON.stringify(source.value)}`);
  }

  return port;
}
