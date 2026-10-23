import { describe, it, expect, vi, afterEach } from "vitest";
import { needsNativeYoutubeControls } from "./fullscreen";

type Device = {
  coarse: boolean;
  requestFullscreen?: boolean;
  webkit?: boolean;
  orientationLock?: boolean;
};

function stubDevice(d: Device): void {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: d.coarse && /pointer:\s*coarse/.test(q) }),
  });
  vi.stubGlobal("document", {
    documentElement: {
      ...(d.requestFullscreen ? { requestFullscreen: () => Promise.resolve() } : {}),
      ...(d.webkit ? { webkitRequestFullscreen: () => {} } : {}),
    },
    fullscreenElement: null,
    addEventListener: () => {},
  });
  vi.stubGlobal(
    "screen",
    d.orientationLock ? { orientation: { lock: () => Promise.resolve(), unlock: () => {} } } : {},
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("needsNativeYoutubeControls", () => {
  it("keeps custom controls when the Fullscreen API exists even without screen.orientation.lock (Firefox Android)", () => {
    stubDevice({ coarse: true, requestFullscreen: true, orientationLock: false });
    expect(needsNativeYoutubeControls()).toBe(false);
  });

  it("counts the webkit-prefixed Fullscreen API as available", () => {
    stubDevice({ coarse: true, webkit: true });
    expect(needsNativeYoutubeControls()).toBe(false);
  });

  it("hands over to YouTube only on touch devices with no Fullscreen API at all (iPhone Safari)", () => {
    stubDevice({ coarse: true });
    expect(needsNativeYoutubeControls()).toBe(true);
  });

  it("never uses YouTube's controls for fine pointers", () => {
    stubDevice({ coarse: false });
    expect(needsNativeYoutubeControls()).toBe(false);
  });

  it("returns false without window/document (SSR)", () => {
    expect(needsNativeYoutubeControls()).toBe(false);
  });
});
