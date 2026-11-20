const NO_CONTEXT_SELECT = "data-no-context-select";

/** Spread on an element where a right click must not select text: `ContextSelectGuard` stops the selection. */
export const NO_CONTEXT_SELECT_MARK = { [NO_CONTEXT_SELECT]: "" } as const;

export const NO_CONTEXT_SELECT_SELECTOR = `[${NO_CONTEXT_SELECT}]`;
