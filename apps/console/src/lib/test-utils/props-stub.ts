/**
 * A vi.mock factory body that replaces a Svelte component with props-stub.svelte, labelled with
 * the stubbed component's name:
 *
 *   vi.mock("$lib/components/stations/HealthPanel.svelte", async () =>
 *     (await import("$lib/test-utils/props-stub")).propsStub("HealthPanel"));
 */
import type { Component } from "svelte";
import PropsStub from "./props-stub.svelte";

/** The props each stubbed component was last mounted with, by name, so a test can call a
 *  callback the parent handed down (e.g. FileBrowser's onOpenConfigEditor). */
export const stubProps = new Map<string, Record<string, unknown>>();

export function propsStub(name: string): { default: Component<Record<string, unknown>> } {
  const Stub: Component<Record<string, unknown>> = PropsStub;
  const Named: Component<Record<string, unknown>> = (anchor, props) => {
    stubProps.set(name, props);
    return Stub(anchor, new Proxy(props, {
      get: (target, key) => (key === "__stub" ? name : Reflect.get(target, key)),
      has: (target, key) => key === "__stub" || Reflect.has(target, key),
      ownKeys: (target) => [...Reflect.ownKeys(target), "__stub"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "__stub"
          ? { value: name, enumerable: true, configurable: true }
          : Reflect.getOwnPropertyDescriptor(target, key),
    }));
  };
  return { default: Named };
}
