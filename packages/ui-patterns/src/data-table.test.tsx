// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, DataTableSkeleton } from "./data-table.js";
import { DataRefreshMarker } from "./loading-state.js";

type Person = { id: string; name: string };
const rows: Person[] = [
  { id: "1", name: "Ana" },
  { id: "2", name: "Bruno" },
];
const columns: ColumnDef<Person>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Nombre" },
];

afterEach(cleanup);

function TestTable({ onRowClick }: { onRowClick: (row: Person) => void }) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  return <DataTable table={table} onRowClick={onRowClick} />;
}

describe("DataTable", () => {
  it("renderiza celdas y entrega la fila pulsada", () => {
    const onRowClick = vi.fn();
    render(<TestTable onRowClick={onRowClick} />);
    expect(screen.getByText("Ana")).toBeTruthy();
    expect(screen.getByText("Bruno")).toBeTruthy();
    fireEvent.click(screen.getByText("Bruno"));
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });

  it("mantiene la geometría de la tabla durante la carga inicial", () => {
    const { container } = render(
      <DataTableSkeleton columnCount={3} rowCount={2} showPagination />,
    );
    const status = screen.getByRole("status", { name: "Cargando…" });

    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll("thead [data-slot='skeleton']")).toHaveLength(3);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelectorAll("tbody [data-slot='skeleton']")).toHaveLength(6);
  });

  it("muestra el Marker oficial con shimmer durante una actualización", () => {
    render(<DataRefreshMarker />);
    const status = screen.getByRole("status");
    const content = screen.getByText("Actualizando…");

    expect(status).toBeTruthy();
    expect(content.classList.contains("shimmer")).toBe(true);
    expect(content.classList.contains("shimmer-color-accent/60")).toBe(true);
    expect(content.classList.contains("motion-reduce:shimmer-none")).toBe(true);
  });
});
