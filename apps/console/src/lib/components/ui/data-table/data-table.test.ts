import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import DataTable from "./data-table.svelte";
import type { ColumnDef } from "@tanstack/table-core";

type Row = { name: string; status: string };
const columns: ColumnDef<Row>[] = [
	{ accessorKey: "name", header: "Name" },
	{ accessorKey: "status", header: "Status" },
];
const data: Row[] = [
	{ name: "hermes-01", status: "running" },
	{ name: "forge-01", status: "stopped" },
];

describe("DataTable", () => {
	it("renders headers and rows", () => {
		render(DataTable, { columns, data } as never);
		expect(screen.getByText("Name")).toBeTruthy();
		expect(screen.getByText("hermes-01")).toBeTruthy();
		expect(screen.getByText("forge-01")).toBeTruthy();
	});

	it("shows the empty state when data is empty", () => {
		render(DataTable, { columns, data: [], emptyTitle: "No rows" } as never);
		expect(screen.getByText("No rows")).toBeTruthy();
	});

	it("reorders rows when a sortable header is activated via keyboard", async () => {
		render(DataTable, { columns, data } as never);
		const nameHeaderButton = screen.getByRole("button", { name: "Name" });

		nameHeaderButton.focus();
		expect(document.activeElement).toBe(nameHeaderButton);
		await fireEvent.keyDown(nameHeaderButton, { key: "Enter" });

		const rows = screen.getAllByRole("row").slice(1); // drop the header row
		expect(rows[0].textContent).toContain("forge-01");
		expect(rows[1].textContent).toContain("hermes-01");
		expect(nameHeaderButton.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
	});
});
