/**
 * A file of the pinned treaty release's data, as text, for tests to parse into the shape they read.
 * The installed `@superjackfruitlabs/treaty-contracts` carries treaty's schemas and fixtures under
 * `data/`, at the version `treaty.json` pins.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installedDataDir } from "@superjackfruitlabs/treaty-contracts/node";

export function treatyText(path: string): string {
  return readFileSync(join(installedDataDir(), path), "utf8");
}
