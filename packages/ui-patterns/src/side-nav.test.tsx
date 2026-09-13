// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SideNav } from "./side-nav.js";

afterEach(cleanup);

const items = [
  { value: "general", label: "General" },
  { value: "pagos", label: "Pagos" },
  { value: "equipo", label: "Equipo" },
] as const;

describe("SideNav", () => {
  it("renderiza todas las secciones como filas", () => {
    render(<SideNav aria-label="Configuración" items={items} value="general" onValueChange={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Configuración" })).toBeTruthy();
    for (const item of items) {
      expect(screen.getByRole("button", { name: item.label })).toBeTruthy();
    }
  });

  it("marca la sección activa con aria-current", () => {
    render(<SideNav aria-label="Configuración" items={items} value="pagos" onValueChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Pagos" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "General" }).getAttribute("aria-current")).toBeNull();
  });

  it("notifica el valor al hacer clic", () => {
    const onValueChange = vi.fn();
    render(<SideNav aria-label="Configuración" items={items} value="general" onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Equipo" }));
    expect(onValueChange).toHaveBeenCalledWith("equipo");
  });
});
