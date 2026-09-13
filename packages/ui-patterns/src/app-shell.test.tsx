// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell } from "./app-shell.js";

afterEach(cleanup);

function shell(fluid?: boolean) {
  return render(
    <AppShell
      items={[]}
      LinkComponent={({ children }: { children: ReactNode }) => <span>{children}</span>}
      pathname="/pos"
      user={{ name: "Caja" }}
      onSignOut={() => {}}
      brand={<span>uunit9</span>}
      fluid={fluid}
    >
      <p>contenido</p>
    </AppShell>,
  );
}

describe("AppShell fluid", () => {
  it("contenido acotado por defecto", () => {
    const { container } = shell();
    expect(container.querySelector("main > div")?.className).toContain("max-w-[1280px]");
  });

  it("pantallas operativas usan todo el ancho sin tope", () => {
    const { container } = shell(true);
    const content = container.querySelector("main > div");
    expect(content?.className).toContain("max-w-none");
    expect(content?.className).not.toContain("max-w-[1280px]");
  });
});
