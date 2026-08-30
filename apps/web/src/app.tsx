import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useId } from "react";
import { useTheme } from "./lib/theme";
import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES } from "./store/ui";

/** The shell every later surface renders inside. It carries no product screen. */
export function App() {
  const { preference, setPreference } = useTheme();
  const themeLabelId = useId();

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      {/* The brand is not a heading: the page's one <h1> opens the main content. */}
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <span className="font-chrome text-lg font-semibold tracking-tight">tasma</span>
        <div className="flex items-center gap-2">
          {/* The group label is visible, not aria-label alone: "System" does not say what it follows. */}
          <span id={themeLabelId} className="font-chrome text-xs text-muted">
            Theme
          </span>
          {/*
           * One of three, so it is a radio group rather than three toggles: a
           * screen reader gets the set size and position, and the group takes a
           * single tab stop.
           */}
          <RadioGroup
            aria-labelledby={themeLabelId}
            value={preference}
            onValueChange={setPreference}
            className="flex gap-1.5 rounded-control bg-surface-2 p-1"
          >
            {THEME_PREFERENCES.map((value) => (
              <Radio.Root
                key={value}
                value={value}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-transparent px-3 py-2 font-chrome text-xs text-dim hover:text-text data-[checked]:border-graphic data-[checked]:bg-surface data-[checked]:text-text"
              >
                {/*
                 * Forced-colors mode replaces every author colour, so the border
                 * carrying the state in normal mode says nothing there. The dot
                 * is drawn from its own border and hidden by visibility, the one
                 * property forced colors does not override.
                 */}
                <Radio.Indicator
                  keepMounted
                  className="size-1.5 rounded-full border-[3px] border-graphic data-[unchecked]:invisible"
                />
                {THEME_PREFERENCE_LABELS[value]}
              </Radio.Root>
            ))}
          </RadioGroup>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <h1 className="sr-only">Workspace</h1>
        <p className="max-w-md text-center text-sm text-muted">
          The workspace is standing by. Surfaces land here as they are built.
        </p>
      </main>
    </div>
  );
}
