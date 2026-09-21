import { act } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";

/** The frame an announcement waits for. */
export async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  });
}

// Words the test before raised land a frame after the call, so that frame runs
// before the reset rather than inside this test. A fake clock runs no frame
// until it is advanced, and a file in the node environment has no frames.
beforeEach(async () => {
  if (typeof requestAnimationFrame === "function" && !vi.isFakeTimers()) {
    await frame();
  }
  useNoticeStore.setState({ notices: [], dismissed: new Map(), announced: [] });
});
