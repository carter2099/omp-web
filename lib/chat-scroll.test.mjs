import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEAR_BOTTOM_PX,
  isNearBottom,
  isNearContentEnd,
  scrolledUpEnough,
  scrollTopToRevealBottom,
  stickAfterScrollEvent,
  stickFromScrollMetrics,
} from "./chat-scroll.ts";

test("isNearBottom: true when flush at bottom", () => {
  // Given scrollHeight 1000, clientHeight 400, scrollTop 600 → distance 0
  assert.equal(isNearBottom(1000, 600, 400), true);
});

test("isNearBottom: true within threshold", () => {
  // distance = 1000 - 550 - 400 = 50 < 80
  assert.equal(isNearBottom(1000, 550, 400, NEAR_BOTTOM_PX), true);
});

test("isNearBottom: false when user scrolled up past threshold", () => {
  // distance = 1000 - 400 - 400 = 200 > 80
  assert.equal(isNearBottom(1000, 400, 400, NEAR_BOTTOM_PX), false);
});

test("isNearBottom: treats non-finite as at bottom (safe default for stick)", () => {
  assert.equal(isNearBottom(NaN, 0, 100), true);
});

test("stickFromScrollMetrics matches isNearBottom", () => {
  assert.equal(stickFromScrollMetrics(2000, 1920, 100, 80), true);
  assert.equal(stickFromScrollMetrics(2000, 1000, 100, 80), false);
});

test("scrollTopToRevealBottom: increases scrollTop when target is below fold", () => {
  // container bottom 500, target bottom 560 → need +60
  assert.equal(scrollTopToRevealBottom(100, 500, 560), 160);
});

test("scrollTopToRevealBottom: decreases scrollTop when target is above fold bottom", () => {
  // overscrolled: target above container bottom
  assert.equal(scrollTopToRevealBottom(200, 500, 480), 180);
});

test("scrollTopToRevealBottom: applies bottom pad", () => {
  assert.equal(scrollTopToRevealBottom(0, 400, 400, 12), 12);
});

test("scrollTopToRevealBottom: never returns negative", () => {
  assert.equal(scrollTopToRevealBottom(5, 500, 400), 0);
});

test("stickAfterScrollEvent: user away from bottom unsticks", () => {
  assert.equal(
    stickAfterScrollEvent({ nearBottom: false, ignoreProgrammatic: false, previousStick: true }),
    false,
  );
});

test("stickAfterScrollEvent: programmatic ignore keeps stick while away", () => {
  assert.equal(
    stickAfterScrollEvent({ nearBottom: false, ignoreProgrammatic: true, previousStick: true }),
    true,
  );
});

test("stickAfterScrollEvent: near bottom without ignore sticks", () => {
  assert.equal(
    stickAfterScrollEvent({ nearBottom: true, ignoreProgrammatic: false, previousStick: false }),
    true,
  );
});

test("stickAfterScrollEvent: near bottom with ignore keeps previous", () => {
  assert.equal(
    stickAfterScrollEvent({ nearBottom: true, ignoreProgrammatic: true, previousStick: false }),
    false,
  );
});

test("isNearContentEnd: true when end aligns with viewport bottom", () => {
  assert.equal(isNearContentEnd(500, 500), true);
  assert.equal(isNearContentEnd(500, 540, NEAR_BOTTOM_PX), true);
});

test("isNearContentEnd: false when end is far below viewport", () => {
  // content end 200px below fold — user scrolled up relative to content
  assert.equal(isNearContentEnd(500, 700, NEAR_BOTTOM_PX), false);
});

test("isNearContentEnd: true when end is above viewport bottom (overscrolled)", () => {
  assert.equal(isNearContentEnd(500, 480), true);
});

test("scrolledUpEnough: detects upward scrollbar drag", () => {
  assert.equal(scrolledUpEnough(400, 300), true);
  assert.equal(scrolledUpEnough(400, 399), false);
  assert.equal(scrolledUpEnough(null, 100), false);
});
