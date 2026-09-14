export function parseUserAgent(ua: string | null | undefined): { browser: string; os: string } {
  const value = ua ?? "";
  const browser = /Edg\//.test(value) ? "Edge"
    : /Chrome\//.test(value) ? "Chrome"
    : /Firefox\//.test(value) ? "Firefox"
    : /Safari\//.test(value) && /Version\//.test(value) ? "Safari"
    : /curl\//.test(value) ? "curl"
    : "Navegador desconocido";
  const os = /Windows/.test(value) ? "Windows"
    : /iPhone|iPad/.test(value) ? "iOS"
    : /Mac OS X/.test(value) ? "macOS"
    : /Android/.test(value) ? "Android"
    : /Linux/.test(value) ? "Linux"
    : "SO desconocido";
  return { browser, os };
}

export function relativeTime(input: string | Date): string {
  const seconds = Math.round((new Date(input).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}
