// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewButton } from "./new-button.js";

afterEach(cleanup);

describe("NewButton", () => {
  it("muestra el label y dispara onClick", () => {
    const onClick = vi.fn();
    render(<NewButton label="Nueva mesa" onClick={onClick} />);
    const button = screen.getByRole("button", { name: /Nueva mesa/ });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("respeta disabled", () => {
    const onClick = vi.fn();
    render(<NewButton label="Nueva mesa" onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: /Nueva mesa/ });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("incluye el icono Plus oculto a lectores de pantalla", () => {
    render(<NewButton label="Nuevo producto" onClick={() => {}} />);
    const button = screen.getByRole("button", { name: /Nuevo producto/ });
    expect(button.querySelector("svg[aria-hidden]")).not.toBeNull();
  });
});
