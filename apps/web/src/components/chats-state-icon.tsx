import type { AgentState } from "@tasma/protocol";
import { Fragment, type ReactNode } from "react";

const COLOUR_CLASS: Record<AgentState, string> = {
  "off": "text-graphic",
  "running": "text-running",
  "needs-you": "text-signal",
};

const CONTRAST_CLASS = "contrast-more:[--ring-outer:1] contrast-more:[--ring-inner:1]";

const RINGS_CLASS: Record<AgentState, string> = {
  "off": "[--ring-outer:0.3] [--ring-inner:0.6]",
  "running": "[--ring-outer:0.3] [--ring-inner:0.6]",
  "needs-you": "[--ring-inner:0.45]",
};

const ANIMATION_CLASS: Record<AgentState, { outer?: string; inner?: string; lamp?: string }> = {
  "off": {},
  "running": { outer: "animate-chats-ripple-outer", inner: "animate-chats-ripple-inner" },
  "needs-you": { inner: "animate-chats-glow", lamp: "animate-chats-breathe" },
};

const OUTER_CLASS = "left-[1.125px] top-[1.125px] size-[17.75px] border-[1.08px] border-current opacity-(--ring-outer)";
const INNER_CLASS = "left-[3.585px] top-[3.585px] size-[12.83px] border-[1.33px] border-current opacity-(--ring-inner)";
const LAMP_CLASS = "left-[6.75px] top-[6.75px] size-[6.5px]";
const HOLLOW_LAMP_CLASS = `${LAMP_CLASS} border-[1.08px] border-current`;
const FILLED_LAMP_CLASS = `${LAMP_CLASS} bg-current`;

function Layer({ shape, animation }: { shape: string; animation: string | undefined }): ReactNode {
  const motionClass = animation === undefined ? "" : ` ${animation} will-change-[transform,opacity] motion-reduce:animate-none`;

  return <span className={`absolute rounded-full ${shape}${motionClass}`} />;
}

/**
 * The Signal mark at 20 px, from HTML layers: WebKit moves an animated layer on
 * the GPU, and repaints an animated SVG on each frame.
 */
export function ChatsStateIcon({ state, still = false }: { state: AgentState; still?: boolean }): ReactNode {
  const animation = still ? {} : ANIMATION_CLASS[state];

  return (
    <span aria-hidden="true" className={`relative block size-[20px] ${COLOUR_CLASS[state]} ${RINGS_CLASS[state]} ${CONTRAST_CLASS}`}>
      {/* A new state mounts new layers, so its motion starts from the first frame. */}
      <Fragment key={state}>
        {state !== "needs-you" && <Layer shape={OUTER_CLASS} animation={animation.outer} />}
        <Layer shape={INNER_CLASS} animation={animation.inner} />
        <Layer shape={state === "off" ? HOLLOW_LAMP_CLASS : FILLED_LAMP_CLASS} animation={animation.lamp} />
      </Fragment>
    </span>
  );
}
