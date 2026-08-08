import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
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
});
