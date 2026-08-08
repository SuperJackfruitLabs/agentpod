import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
// Static import: compiled during file collection, not during the test body,
// so the first test's waitFor window isn't eaten by compilation time.
import LogTail from "./LogTail.svelte";

beforeEach(() => vi.restoreAllMocks());

// Minimal EventSource stub — captures the last instance so tests can fire events.
// jsdom does not provide EventSource natively; we install this before rendering.
class MockEventSource {
  static instance: MockEventSource | null = null;
  // Every constructed instance, in order — lets reconnect tests assert that a
  // *new* EventSource was opened after backoff, not just that one exists.
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instance = this;
    MockEventSource.instances.push(this);
    // Simulate open after construction so onopen fires asynchronously
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));
    }, 0);
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  /** Fire a message event — called from test code to simulate SSE data. */
  fireMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

afterEach(() => {
  MockEventSource.instance = null;
  MockEventSource.instances = [];
  cleanup();
});

test("LogTail opens EventSource with logsUrl and renders lines", async () => {
  vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
  // Install stub before component mounts so onMount picks it up
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

  const { getByText } = render(LogTail, { props: { stationId: "s1" } });

  // Wait for the MockEventSource to be constructed (onMount ran)
  await waitFor(() => expect(MockEventSource.instance).toBeTruthy());

  // Fire a log line
  MockEventSource.instance!.fireMessage("2026-06-27 hello from agent");

  await waitFor(() => {
    expect(getByText(/hello from agent/)).toBeTruthy();
  });

  expect(api.logsUrl).toHaveBeenCalledWith("s1");
});

test("LogTail appends multiple lines in order", async () => {
  vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

  const { getByText } = render(LogTail, { props: { stationId: "s1" } });

  await waitFor(() => expect(MockEventSource.instance).toBeTruthy());

  MockEventSource.instance!.fireMessage("line one");
  MockEventSource.instance!.fireMessage("line two");
  MockEventSource.instance!.fireMessage("line three");

  // Lines beyond the first in a synchronous burst are batched and flush on
  // a trailing timer (LogTail batches ingestion at most once per 50ms).
  await new Promise((resolve) => setTimeout(resolve, 60));

  await waitFor(() => {
    expect(getByText(/line one/)).toBeTruthy();
    expect(getByText(/line two/)).toBeTruthy();
    expect(getByText(/line three/)).toBeTruthy();
  });
});

test("LogTail caps rendered lines at MAX_LINES=10000 and keeps most recent", async () => {
  vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

  render(LogTail, { props: { stationId: "s1" } });
  await waitFor(() => expect(MockEventSource.instance).toBeTruthy());

  // Fire 10_500 log lines — 500 more than MAX_LINES — all synchronously.
  // LogTail batches ingestion (flushes the reactive `lines` array at most
  // once per 50ms), so this burst lands in one leading flush (line 1) plus
  // one trailing flush (lines 2..10500) instead of 10,500 separate
  // array-copy + derived recomputes.
  for (let i = 1; i <= 10_500; i++) {
    MockEventSource.instance!.fireMessage(`logline-${i}`);
  }

  // Let the trailing batch-flush timer fire once.
  await new Promise((resolve) => setTimeout(resolve, 60));

  await waitFor(() => {
    // The header counter must reflect the cap (10000), not the total (10500)
    expect(document.body.textContent).toMatch(/\b10000 lines\b/);
    // The most-recent line must be visible
    expect(document.body.textContent).toContain("logline-10500");
  });
});

test("filters by level chip and search text", async () => {
  vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

  const { getByText, queryByText, getByPlaceholderText } = render(LogTail, {
    props: { stationId: "s1" },
  });
  await waitFor(() => expect(MockEventSource.instance).toBeTruthy());

  MockEventSource.instance!.fireMessage("ERROR boom");
  MockEventSource.instance!.fireMessage("WARN slow");
  MockEventSource.instance!.fireMessage("INFO ok");

  // "boom" (message 1) flushes immediately; "slow"/"ok" batch onto the
  // trailing 50ms flush — wait for it so all three chip counts are settled
  // before filtering.
  await new Promise((resolve) => setTimeout(resolve, 60));

  await waitFor(() => expect(getByText(/boom/)).toBeTruthy());

  // Level counts are visible on the chips regardless of filter/search state.
  const errorChip = getByText("Error 1");
  await fireEvent.click(errorChip);

  await waitFor(() => {
    expect(getByText(/boom/)).toBeTruthy();
    expect(queryByText(/slow/)).toBeNull();
    expect(queryByText(/\bok\b/)).toBeNull();
  });

  // Back to "All" so the search filter is exercised on its own.
  await fireEvent.click(getByText("All"));
  await waitFor(() => expect(getByText(/slow/)).toBeTruthy());

  const search = getByPlaceholderText("Search logs…");
  await fireEvent.input(search, { target: { value: "slo" } });

  // The matched substring is wrapped in <mark>, splitting "slow" across
  // nodes — assert on aggregate textContent rather than a single-node query.
  await waitFor(() => {
    expect(document.body.textContent).toContain("slow");
    expect(document.body.textContent).not.toContain("boom");
    expect(document.body.textContent).not.toMatch(/\bok\b/);
    expect(document.querySelector("mark")?.textContent).toBe("slo");
  });
});

test("pauses follow on scroll-up and shows new-lines pill", async () => {
  vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

  const { getByTestId, getByText, queryByText } = render(LogTail, {
    props: { stationId: "s1" },
  });
  await waitFor(() => expect(MockEventSource.instance).toBeTruthy());

  const scrollContainer = getByTestId("log-scroll-container");

  // jsdom does not compute layout — stub the metrics a "scrolled up" reader
  // would produce (far from the bottom of the scroll area).
  Object.defineProperty(scrollContainer, "scrollTop", { value: 0, configurable: true });
  Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(scrollContainer, "clientHeight", { value: 200, configurable: true });
  await fireEvent.scroll(scrollContainer);

  MockEventSource.instance!.fireMessage("one");
  MockEventSource.instance!.fireMessage("two");
  MockEventSource.instance!.fireMessage("three");

  // "one" flushes immediately (pill shows "1 new line"); "two"/"three"
  // land on the trailing batch flush.
  await new Promise((resolve) => setTimeout(resolve, 60));

  await waitFor(() => expect(getByText(/3 new lines/)).toBeTruthy());

  await fireEvent.click(getByText(/3 new lines/));

  await waitFor(() => expect(queryByText(/new lines/)).toBeNull());
});

test("reconnects after error with backoff", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(api, "logsUrl").mockReturnValue("http://hub/api/stations/s1/logs");
    (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

    render(LogTail, { props: { stationId: "s1" } });
    await vi.waitFor(() => expect(MockEventSource.instance).toBeTruthy());
    // Let the mock's own setTimeout(0) fire so it reaches "open"/connected.
    await vi.advanceTimersByTimeAsync(0);

    expect(MockEventSource.instances.length).toBe(1);

    MockEventSource.instance!.onerror?.(new Event("error"));

    // Backoff for the first retry is 1s — before that elapses, no new instance.
    await vi.advanceTimersByTimeAsync(999);
    expect(MockEventSource.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(MockEventSource.instances.length).toBe(2);
    expect(MockEventSource.instances[1]).not.toBe(MockEventSource.instances[0]);
  } finally {
    vi.useRealTimers();
  }
});
