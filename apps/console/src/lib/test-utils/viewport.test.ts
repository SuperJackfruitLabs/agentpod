import { afterEach, expect, test } from "vitest";
import { overflowingElements, setViewport } from "./viewport";

afterEach(() => { document.body.innerHTML = ""; });

test("a fixed width past the screen is reported; one inside a sideways scroller is not", () => {
  document.body.innerHTML = `
    <div class="min-w-[640px]" id="wide"></div>
    <div class="overflow-x-auto"><div class="min-w-[880px]"></div></div>
    <div style="width: 500px"></div>
    <table class="ap-tbl--cards min-w-[880px]"></table>`;
  const found = overflowingElements(document.body, 390);
  expect(found).toHaveLength(2);
  expect(found[0]).toMatch(/640px/);
  expect(found[1]).toMatch(/500px/);
});

test("a card table's min-width counts above the cards breakpoint", () => {
  document.body.innerHTML = `<table class="ap-tbl--cards min-w-[880px]"></table>`;
  expect(overflowingElements(document.body, 800)).toHaveLength(1);
  expect(overflowingElements(document.body, 390)).toHaveLength(0);
});

test("setViewport answers matchMedia for the given width and restores it", () => {
  const restore = setViewport(390);
  expect(window.matchMedia("(max-width: 767px)").matches).toBe(true);
  expect(window.matchMedia("(min-width: 901px)").matches).toBe(false);
  expect(window.innerWidth).toBe(390);
  restore();
  expect(window.matchMedia("(max-width: 767px)").matches).toBe(false);
});
