import type { TokenizeRequest } from "./shiki-tokenize";

// WebKit runs this entry module a second time when a chunk imports it. Behind
// import(), the tokenizer and the code it shares with the grammar chunks stay
// out of the entry chunk.
const tokenizer = import("./shiki-tokenize").then(({ createTokenizer }) => createTokenizer());

addEventListener("message", (event: MessageEvent<TokenizeRequest>) => {
  void tokenizer
    .then((tokenize) => tokenize(event.data))
    .then((reply) => {
      postMessage(reply);
    });
});
