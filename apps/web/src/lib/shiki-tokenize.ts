import { createHighlighterCore, guessEmbeddedLanguages, isSpecialLang, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, type BundledLanguage } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

export type Hast = ReturnType<HighlighterCore["codeToHast"]>;

export type TokenizeRequest = { id: number; code: string; language: string };

/** A reply with no `hast` keeps the block plain. */
export type TokenizeReply = { id: number; hast?: Hast };

const THEMES = { light: "github-light-default", dark: "github-dark-default" } as const;

function isBundled(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language);
}

/** Loads the grammar of `language` and of the languages embedded in `code`, and names the grammar to use. */
async function loadLanguage(highlighter: HighlighterCore, code: string, language: string): Promise<string> {
  if (!isBundled(language)) return isSpecialLang(language) ? language : "plaintext";
  const loaded = highlighter.getLoadedLanguages();
  const missing = [language, ...guessEmbeddedLanguages(code, language)]
    .filter(isBundled)
    .filter((name) => !loaded.includes(name));
  await highlighter.loadLanguage(...missing.map((name) => bundledLanguages[name]));
  return language;
}

/** The Shiki tokenizer of the highlighter worker. It runs one request at a time. */
export function createTokenizer(): (request: TokenizeRequest) => Promise<TokenizeReply> {
  const highlighter = createHighlighterCore({
    // With a target after ES2018, WebKit gives the line after a `//` comment the
    // comment colour. `forgiving` skips the patterns that ES2018 cannot express.
    engine: createJavaScriptRegexEngine({ target: "ES2018", forgiving: true }),
    themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
  });

  return async ({ id, code, language }) => {
    try {
      const ready = await highlighter;
      const lang = await loadLanguage(ready, code, language);
      return {
        id,
        hast: ready.codeToHast(code, {
          lang,
          themes: THEMES,
          defaultColor: "light-dark()",
          tokenizeMaxLineLength: 1_000,
          // Shiki counts the compile of a grammar in the time limit of a line, so a
          // limit can cut the first line of the first block of a large grammar.
          tokenizeTimeLimit: 0,
        }),
      };
    } catch {
      return { id };
    }
  };
}
