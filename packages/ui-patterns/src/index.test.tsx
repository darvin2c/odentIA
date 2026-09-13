import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";

describe("ui-patterns barrel", () => {
  it("re-exporta las composiciones esperadas", () => {
    expect(typeof barrel.PageShell).toBe("function");
    expect(typeof barrel.LoadingState).toBe("function");
    expect(typeof barrel.EmptyState).toBe("function");
    expect(typeof barrel.ErrorState).toBe("function");
    expect(typeof barrel.KpiCard).toBe("function");
    expect(typeof barrel.FormDrawer).toBe("function");
    expect(typeof barrel.AppShell).toBe("function");
    expect(typeof barrel.PageHeader).toBe("function");
    expect(typeof barrel.isNavItemActive).toBe("function");
  });
});
