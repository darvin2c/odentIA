// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmitButton } from "./submit-button.js";

afterEach(cleanup);

describe("SubmitButton", () => {
  it("renderiza el label sin spinner en reposo", () => {
    render(<SubmitButton>Guardar</SubmitButton>);
    const button = screen.getByRole("button", { name: "Guardar" });
    expect(button.getAttribute("disabled")).toBeNull();
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("pending deshabilita, conserva el label y muestra Spinner", () => {
    render(<SubmitButton pending>Guardar</SubmitButton>);
    const button = screen.getByRole("button", { name: /Guardar/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it("disabled sin pending deshabilita sin spinner", () => {
    render(<SubmitButton disabled>Guardar</SubmitButton>);
    const button = screen.getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("llama onClick en reposo", () => {
    const onClick = vi.fn();
    render(<SubmitButton onClick={onClick}>Guardar</SubmitButton>);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
