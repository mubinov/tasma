/**
 * The most of a value a file supplied that a message carries. The file states
 * how long its own id is, and a message and an exclusion the index holds for the
 * life of the project are no place for whatever length it chose.
 */
export const VALUE_LIMIT = 60;

/**
 * The same for a reason, which names the file and the line of the fault before
 * it quotes anything the file supplied.
 */
export const REASON_LIMIT = 200;

/**
 * What a message may not carry of what a file supplied: the characters that end
 * a line or drive a terminal, which would let a file dictate how a diagnostic of
 * it renders, and a lone surrogate, which stands for no character at all. Each
 * is replaced by a space.
 *
 * The line and the paragraph separator are named beside the controls because
 * they end a line for a renderer that is not a terminal: a view that honours
 * them would show what follows one as a second line the index never wrote.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * What a message carries of a string another party supplied, and no more. Every
 * message the index composes puts what it quotes through this, so the length and
 * the characters of a diagnostic are the index's own whatever a file, or a fault
 * raised over one, holds.
 */
export function short(value: string, limit = VALUE_LIMIT): string {
  const text = value.replace(CONTROL, " ");
  if (text.length <= limit) return text;
  // The cut falls between characters: the leading half of one that takes two
  // code units is no character either.
  return `${text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")}...`;
}
