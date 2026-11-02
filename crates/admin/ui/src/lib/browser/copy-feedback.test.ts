import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyFeedback } from "./copy-feedback.svelte";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("copy feedback: clears itself after the duration", () => {
  const feedback = new CopyFeedback(1500);
  feedback.report(true);
  expect(feedback.copied).toBe(true);
  vi.advanceTimersByTime(1499);
  expect(feedback.copied).toBe(true);
  vi.advanceTimersByTime(1);
  expect(feedback.copied).toBe(false);
});

it("copy feedback: a second copy is not cut short by the first timer", () => {
  const feedback = new CopyFeedback(1500);
  feedback.report(true);
  vi.advanceTimersByTime(1000);
  feedback.report(true);
  vi.advanceTimersByTime(1000);
  expect(feedback.copied).toBe(true);
  vi.advanceTimersByTime(500);
  expect(feedback.copied).toBe(false);
});

it("copy feedback: leaves no timer running once disposed", () => {
  const feedback = new CopyFeedback(1500);
  feedback.report(true);
  feedback.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
