import { describe, expect, it } from "vitest";
import { parseUserAgent, relativeTime } from "./user-agent";

describe("parseUserAgent", () => {
  it("identifica Chrome en Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({ browser: "Chrome", os: "Windows" });
  });

  it("identifica Safari en iPhone", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({ browser: "Safari", os: "iOS" });
  });

  it("devuelve desconocido con string vacío", () => {
    expect(parseUserAgent("")).toEqual({ browser: "Navegador desconocido", os: "SO desconocido" });
  });
});

describe("relativeTime", () => {
  it("formatea 2 horas atrás en español", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    expect(relativeTime(twoHoursAgo)).toBe("hace 2 horas");
  });

  it("formatea 3 días atrás en español", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    expect(relativeTime(threeDaysAgo)).toBe("hace 3 días");
  });
});
