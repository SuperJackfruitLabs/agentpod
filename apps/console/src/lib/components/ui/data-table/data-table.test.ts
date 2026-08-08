import { describe, expect, it, vi } from "vitest";
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

	it("narrows rows via a bound filterValue that matches no data", () => {
		render(DataTable, { columns, data, filterValue: "zzz-no-match" } as never);
		expect(screen.queryByText("hermes-01")).toBeNull();
		expect(screen.queryByText("forge-01")).toBeNull();
	});

	it("narrows rows via a bound filterValue that matches one row", () => {
		render(DataTable, { columns, data, filterValue: "hermes" } as never);
		expect(screen.getByText("hermes-01")).toBeTruthy();
		expect(screen.queryByText("forge-01")).toBeNull();
	});

	it("shows an in-table empty state titled 'No matching rows' when data exists but the filter matches nothing", () => {
		render(DataTable, { columns, data, filterValue: "zzz-no-match" } as never);
		expect(screen.getByText("No matching rows")).toBeTruthy();
		// The regular "no data at all" empty title must not also be shown.
		expect(screen.queryByText("Nothing here yet")).toBeNull();
	});

	it("applies rowTestId to each rendered body row", () => {
		render(DataTable, { columns, data, rowTestId: "fixture-row" } as never);
		expect(screen.getAllByTestId("fixture-row")).toHaveLength(data.length);
	});

	describe("pagination", () => {
		const pageData: Row[] = Array.from({ length: 5 }, (_, i) => ({
			name: `agent-${i}`,
			status: "running",
		}));

		it("paginates over pageSize-sized data with working Next/Previous", async () => {
			render(DataTable, { columns, data: pageData, pageSize: 2 } as never);

			expect(screen.getByText("Page 1 of 3")).toBeTruthy();
			expect(screen.getByText("agent-0")).toBeTruthy();
			expect(screen.getByText("agent-1")).toBeTruthy();
			expect(screen.queryByText("agent-2")).toBeNull();

			const previousButton = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
			const nextButton = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
			expect(previousButton.disabled).toBe(true);
			expect(nextButton.disabled).toBe(false);

			await fireEvent.click(nextButton);

			expect(screen.getByText("Page 2 of 3")).toBeTruthy();
			expect(screen.getByText("agent-2")).toBeTruthy();
			expect(screen.getByText("agent-3")).toBeTruthy();
			expect(screen.queryByText("agent-0")).toBeNull();
			expect(previousButton.disabled).toBe(false);
			expect(nextButton.disabled).toBe(false);

			await fireEvent.click(previousButton);

			expect(screen.getByText("Page 1 of 3")).toBeTruthy();
			expect(screen.getByText("agent-0")).toBeTruthy();
			expect(previousButton.disabled).toBe(true);
		});

		it("does not render pagination controls when everything fits on one page", () => {
			render(DataTable, { columns, data } as never);
			expect(screen.queryByText(/Page \d+ of \d+/)).toBeNull();
			expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
		});
	});

	describe("manual pagination", () => {
		const singleRowData: Row[] = [{ name: "agent-0", status: "running" }];
		const fiveRowData: Row[] = Array.from({ length: 5 }, (_, i) => ({
			name: `agent-${i}`,
			status: "running",
		}));

		it("renders the footer using the server pageCount despite data holding only one page", () => {
			render(DataTable, {
				columns,
				data: singleRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 0,
			} as never);

			expect(screen.getByText("Page 1 of 3")).toBeTruthy();
			expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
		});

		it("does not re-slice data client-side: a small pageSize still renders every row the server sent", () => {
			// pageSize=2 against 5 rows would leave only 2 visible if the component
			// re-paginated client-side; manual mode must trust the server's page as-is.
			render(DataTable, {
				columns,
				data: fiveRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 0,
				pageSize: 2,
			} as never);

			for (const row of fiveRowData) {
				expect(screen.getByText(row.name)).toBeTruthy();
			}
		});

		it("fires onPageChange with the target index when Next is clicked", async () => {
			const onPageChange = vi.fn();
			render(DataTable, {
				columns,
				data: singleRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 0,
				onPageChange,
			} as never);

			await fireEvent.click(screen.getByRole("button", { name: "Next" }));

			expect(onPageChange).toHaveBeenCalledTimes(1);
			expect(onPageChange).toHaveBeenCalledWith(1);
		});

		it("fires onPageChange with the target index when Previous is clicked from pageIndex 1", async () => {
			const onPageChange = vi.fn();
			render(DataTable, {
				columns,
				data: singleRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 1,
				onPageChange,
			} as never);

			await fireEvent.click(screen.getByRole("button", { name: "Previous" }));

			expect(onPageChange).toHaveBeenCalledTimes(1);
			expect(onPageChange).toHaveBeenCalledWith(0);
		});

		it("disables Previous at pageIndex 0 and does not fire onPageChange", async () => {
			const onPageChange = vi.fn();
			render(DataTable, {
				columns,
				data: singleRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 0,
				onPageChange,
			} as never);

			const previousButton = screen.getByRole("button", {
				name: "Previous",
			}) as HTMLButtonElement;
			expect(previousButton.disabled).toBe(true);

			await fireEvent.click(previousButton);
			expect(onPageChange).not.toHaveBeenCalled();
		});

		it("disables Next at the last page (pageIndex === pageCount - 1)", () => {
			render(DataTable, {
				columns,
				data: singleRowData,
				manualPagination: true,
				pageCount: 3,
				pageIndex: 2,
			} as never);

			const nextButton = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
			expect(nextButton.disabled).toBe(true);
			expect(screen.getByText("Page 3 of 3")).toBeTruthy();
		});
	});
});
