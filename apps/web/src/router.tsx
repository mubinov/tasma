import { createHashHistory } from "@tanstack/react-router";
import { createAppRouter } from "./routes";

// createHashHistory patches the document's history object and registers listeners
// it never releases, so nothing but this module may construct one.
export const router = createAppRouter(createHashHistory());

declare module "@tanstack/react-router" {
  // Declaration merging works on an interface only.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
