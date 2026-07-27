/** Distance from the bottom (px) still treated as "at bottom" for sticky follow. */
export const NEAR_BOTTOM_PX = 80;

/** Ignore scroll events that fire while we programmatically move the viewport. */
export const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;

/**
 * Whether the scroll container is near the bottom.
 * Pure helper — pass DOM metrics so unit tests need no layout.
 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx: number = NEAR_BOTTOM_PX,
): boolean {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight)) {
    return true;
  }
  const distance = scrollHeight - scrollTop - clientHeight;
  return distance <= Math.max(0, thresholdPx);
}

export function metricsFromElement(el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
} {
  return {
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  };
}

/** Update stick flag from current metrics (user scroll, not programmatic). */
export function stickFromScrollMetrics(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx: number = NEAR_BOTTOM_PX,
): boolean {
  return isNearBottom(scrollHeight, scrollTop, clientHeight, thresholdPx);
}

/** Stick decision for scroll events; ignore protects smooth programmatic intermediates only. */
export function stickAfterScrollEvent(input: {
  nearBottom: boolean;
  ignoreProgrammatic: boolean;
  previousStick: boolean;
}): boolean {
  if (!input.nearBottom) {
    return input.ignoreProgrammatic ? input.previousStick : false;
  }
  if (input.ignoreProgrammatic) return input.previousStick;
  return true;
}

/** Near messagesEnd (not scrollHeight) — ignores trailing spacers below the end marker. */
export function isNearContentEnd(
  containerBottom: number,
  contentEndBottom: number,
  thresholdPx: number = NEAR_BOTTOM_PX,
): boolean {
  if (!Number.isFinite(containerBottom) || !Number.isFinite(contentEndBottom)) {
    return true;
  }
  return contentEndBottom - containerBottom <= Math.max(0, thresholdPx);
}

export function scrolledUpEnough(previousScrollTop: number | null, scrollTop: number, minDeltaPx: number = 2): boolean {
  if (previousScrollTop == null || !Number.isFinite(previousScrollTop) || !Number.isFinite(scrollTop)) {
    return false;
  }
  return scrollTop < previousScrollTop - Math.max(0, minDeltaPx);
}

/**
 * ScrollTop that places content end on the container bottom edge.
 * Prefer this over scrollIntoView default block:"start" (pins end to top, hides last lines).
 */
export function scrollTopToRevealBottom(
  scrollTop: number,
  containerBottom: number,
  targetBottom: number,
  bottomPadPx: number = 0,
): number {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(containerBottom) || !Number.isFinite(targetBottom)) {
    return Math.max(0, scrollTop);
  }
  const pad = Number.isFinite(bottomPadPx) ? Math.max(0, bottomPadPx) : 0;
  return Math.max(0, scrollTop + (targetBottom + pad - containerBottom));
}

export const SCROLL_BOTTOM_PAD_PX = 12;
