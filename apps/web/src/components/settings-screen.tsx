import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useId, type ReactNode } from "react";
import { useDocumentTitle } from "../lib/document-title";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon, type IconComponent } from "../lib/icons";
import { NAVIGATION_BY_PATH } from "../navigation";
import { THEME_PREFERENCE_LABELS, THEME_PREFERENCES, useUiStore, type ThemePreference } from "../store/ui";
import { ScreenHeading } from "./screen-heading";

const THEME_PREFERENCE_ICONS: Record<ThemePreference, IconComponent> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

export function SettingsScreen(): ReactNode {
  const { label: title } = NAVIGATION_BY_PATH["/settings"];
  // The store, not useTheme: the subscription that writes the class on <html>
  // is mounted above the router, so a second one held by a screen would die
  // with the route or with a route error.
  const themePreference = useUiStore((state) => state.themePreference);
  const setThemePreference = useUiStore((state) => state.setThemePreference);
  const themeLabelId = useId();

  useDocumentTitle(title);

  return (
    <>
      <ScreenHeading>{title}</ScreenHeading>

      <span id={themeLabelId} className="mt-7 block font-chrome text-sm font-medium">
        Theme
      </span>

      <RadioGroup
        aria-labelledby={themeLabelId}
        value={themePreference}
        onValueChange={setThemePreference}
        className="mt-2 grid w-full max-w-2xl grid-cols-1 gap-3 md:grid-cols-3"
      >
        {THEME_PREFERENCES.map((value) => {
          const Icon = THEME_PREFERENCE_ICONS[value];

          return (
            // Hover moves the border, never the fill: surface-2 sits below the
            // page background in both palettes, so a fill change would recess
            // a card that is raised at rest.
            <Radio.Root
              key={value}
              value={value}
              className="flex cursor-pointer items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 hover:border-graphic data-[checked]:border-graphic"
            >
              <Icon size={20} aria-hidden="true" className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 font-chrome text-base font-medium">{THEME_PREFERENCE_LABELS[value]}</span>
              {/*
               * Forced-colors mode replaces every author colour, so the border
               * carrying the state in normal mode says nothing there. The check
               * is drawn in currentColor and hidden by visibility, the one
               * property forced colors does not override.
               */}
              <Radio.Indicator keepMounted className="shrink-0 data-[unchecked]:invisible">
                <CheckIcon size={16} aria-hidden="true" />
              </Radio.Indicator>
            </Radio.Root>
          );
        })}
      </RadioGroup>
    </>
  );
}
