<script lang="ts" generics="T">
	import {
		getCoreRowModel,
		getSortedRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
		type ColumnDef,
		type SortingState,
	} from "@tanstack/table-core";
	import { createSvelteTable } from "./data-table.svelte.js";
	import FlexRender from "./flex-render.svelte";
	import * as Table from "$lib/components/ui/table/index.js";
	import { Empty } from "$lib/components/ui/empty/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn } from "$lib/utils.js";

	let {
		columns,
		data,
		emptyTitle = "Nothing here yet",
		emptyDescription = undefined,
		pageSize = 50,
		filterValue = $bindable(""),
		class: className = undefined,
		rowTestId = undefined,
		manualPagination = false,
		pageCount = undefined,
		pageIndex = $bindable(0),
		onPageChange = undefined,
	}: {
		columns: ColumnDef<T>[];
		data: T[];
		emptyTitle?: string;
		emptyDescription?: string;
		pageSize?: number;
		filterValue?: string;
		class?: string;
		/** Optional `data-testid` applied to every rendered body row. */
		rowTestId?: string;
		/** Server-driven pagination: caller owns paging `data`; disables client-side slicing. */
		manualPagination?: boolean;
		/** Total page count. Required (and authoritative) when `manualPagination` is true. */
		pageCount?: number;
		/** Current page index (0-based), driven externally when `manualPagination` is true. */
		pageIndex?: number;
		/** Fired with the target page index when Next/Previous is clicked in manual mode. */
		onPageChange?: (pageIndex: number) => void;
	} = $props();

	let sorting = $state<SortingState>([]);

	const table = createSvelteTable({
		get data() {
			return data;
		},
		get columns() {
			return columns;
		},
		state: {
			get sorting() {
				return sorting;
			},
			get globalFilter() {
				return filterValue;
			},
			// Manual pagination is a mount-time mode switch, not a per-render toggle —
			// same non-reactive-branch precedent as the pageSize/initialState seed below.
			// Only in manual mode do we override the internally-managed pagination state
			// with a component-level getter (mirroring the sorting/globalFilter pattern
			// above) so the bound `pageIndex` prop flows into table.getState().pagination
			// on every read.
			// svelte-ignore state_referenced_locally -- manualPagination mode is fixed at mount, by design (see above)
			...(manualPagination
				? {
						get pagination() {
							return { pageIndex, pageSize };
						},
					}
				: {}),
		},
		onSortingChange: (updater) => {
			sorting = typeof updater === "function" ? updater(sorting) : updater;
		},
		onGlobalFilterChange: (updater) => {
			filterValue = typeof updater === "function" ? updater(filterValue) : updater;
		},
		// svelte-ignore state_referenced_locally -- pageSize seeds pagination once at mount, by design
		initialState: { pagination: { pageIndex: 0, pageSize } },
		get manualPagination() {
			return manualPagination;
		},
		get pageCount() {
			return pageCount;
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
	});
</script>

{#if data.length === 0}
	<Empty title={emptyTitle} description={emptyDescription} class={className} />
{:else}
	<div class={cn("rounded-lg border", className)}>
		<Table.Root>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<Table.Row>
						{#each headerGroup.headers as header (header.id)}
							{@const sorted = header.column.getIsSorted()}
							{@const toggleSort = header.column.getToggleSortingHandler()}
							<Table.Head
								aria-sort={sorted === "asc"
									? "ascending"
									: sorted === "desc"
										? "descending"
										: undefined}
							>
								{#if !header.isPlaceholder}
									{#if header.column.getCanSort()}
										<button
											type="button"
											class="flex cursor-pointer select-none items-center gap-1 bg-transparent p-0 font-medium"
											onclick={toggleSort}
											onkeydown={(event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													toggleSort?.(event);
												}
											}}
										>
											<FlexRender
												content={header.column.columnDef.header}
												context={header.getContext()}
											/>
											{#if sorted === "asc"}<span aria-hidden="true"> ↑</span>{/if}
											{#if sorted === "desc"}<span aria-hidden="true"> ↓</span>{/if}
										</button>
									{:else}
										<FlexRender
											content={header.column.columnDef.header}
											context={header.getContext()}
										/>
									{/if}
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#if table.getRowModel().rows.length === 0}
					<Table.Row>
						<Table.Cell colspan={columns.length} class="p-0">
							<Empty title="No matching rows" class="rounded-none border-0" />
						</Table.Cell>
					</Table.Row>
				{:else}
					{#each table.getRowModel().rows as row (row.id)}
						<Table.Row data-testid={rowTestId}>
							{#each row.getVisibleCells() as cell (cell.id)}
								<Table.Cell>
									<FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				{/if}
			</Table.Body>
		</Table.Root>
		{#if manualPagination ? (pageCount ?? 0) > 1 : table.getRowModel().rows.length > 0 && table.getPageCount() > 1}
			<div class="flex items-center justify-end gap-2 border-t px-3 py-2">
				<span class="text-xs text-muted-foreground">
					Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={!table.getCanPreviousPage()}
					onclick={() => {
						if (manualPagination) {
							if (!table.getCanPreviousPage()) return;
							onPageChange?.(table.getState().pagination.pageIndex - 1);
						} else {
							table.previousPage();
						}
					}}
				>
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!table.getCanNextPage()}
					onclick={() => {
						if (manualPagination) {
							if (!table.getCanNextPage()) return;
							onPageChange?.(table.getState().pagination.pageIndex + 1);
						} else {
							table.nextPage();
						}
					}}
				>
					Next
				</Button>
			</div>
		{/if}
	</div>
{/if}
