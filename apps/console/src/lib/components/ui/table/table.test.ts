import { describe, expect, it } from "vitest";
import * as Table from "./index.js";

describe("table primitive", () => {
	it("exports the composable parts", () => {
		expect(Table.Root).toBeTruthy();
		expect(Table.Header).toBeTruthy();
		expect(Table.Body).toBeTruthy();
		expect(Table.Row).toBeTruthy();
		expect(Table.Head).toBeTruthy();
		expect(Table.Cell).toBeTruthy();
	});
});
