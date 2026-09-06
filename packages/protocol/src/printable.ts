// Text a reader takes as data rather than as a command.
//
// Both binaries quote back what an argument, a variable or an answer carried,
// and a terminal takes an escape sequence inside that text as a command — to
// clear the screen, retitle the window or overwrite the line so a failure reads
// as success — while a program splitting the output into lines takes a Unicode
// line separator as a line of its own. Either way the quoted text forges output
// the binary never wrote.
//
// The class has one home because it is a control: a category added to a second
// copy of it would leave the first narrower. This is the package the CLI and the
// daemon both import, and the escape needs nothing a host provides.

const OPAQUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Text safe to print, with every character a reader would act on shown as its escape. */
export function printable(text: string): string {
  return text.replace(OPAQUE, (match) =>
    // By code unit rather than code point, so an astral character keeps both halves.
    match
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}
