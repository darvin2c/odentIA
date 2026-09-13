// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Eliminar mesa"
      description="Solo si nunca tuvo cuentas."
      confirmLabel="Eliminar"
      onConfirm={onConfirm}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onConfirm, onClose };
}

describe("ConfirmDialog", () => {
  it("cerrado no renderiza nada", () => {
    renderDialog({ open: false });
    expect(screen.queryByText("Eliminar mesa")).toBeNull();
  });

  it("muestra título, consecuencia y acciones", () => {
    renderDialog();
    expect(screen.getByText("Eliminar mesa")).toBeTruthy();
    expect(screen.getByText("Solo si nunca tuvo cuentas.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Eliminar" })).toBeTruthy();
  });

  it("confirmar dispara onConfirm sin cerrar solo", () => {
    const { onConfirm, onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
  it("destructive se ve danger; default no", () => {
    renderDialog({ variant: "destructive" });
    const destructive = screen.getByRole("button", { name: "Eliminar" });
    expect(destructive.className).toContain("bg-destructive");
    expect(destructive.className).toContain("text-destructive-foreground");
    cleanup();
    document.body.innerHTML = "";
    renderDialog({ variant: "default", confirmLabel: "Archivar" });
    const archival = screen.getByRole("button", { name: "Archivar" });
    expect(archival.className).not.toContain("bg-destructive");
  });

  it("pending bloquea ambas acciones", () => {
    const { onConfirm, onClose } = renderDialog({ pending: true });
    const confirm = screen.getByRole("button", { name: /Eliminar/ });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
