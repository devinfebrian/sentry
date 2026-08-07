import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireUser: vi.fn(),
}));

vi.mock("../_shared/auth.ts", () => authMocks);

function optionsRequest(origin?: string) {
  const headers = new Headers();
  if (origin) {
    headers.set("Origin", origin);
  }

  return new Request("http://localhost/functions/v1/invite-member", {
    method: "OPTIONS",
    headers,
  });
}

async function loadRoute(environment: Record<string, string | undefined>) {
  vi.resetModules();
  vi.stubGlobal("Deno", {
    env: { get: (name: string) => environment[name] },
    serve: vi.fn(),
  });

  const module = await import("./index.ts");
  return module.handleRoute;
}

describe("invite-member hosted CORS route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("allows configured HTTPS origin and rejects unconfigured origin", async () => {
    const handleRoute = await loadRoute({
      DENO_DEPLOYMENT_ID: "deployment-1",
      SENTINEL_ALLOWED_ORIGINS: "https://app.example",
    });

    const allowed = await handleRoute(optionsRequest("https://app.example"));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");

    const blocked = await handleRoute(optionsRequest("https://other.example"));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Origin not allowed." });
  });

  it("rejects hosted origin when allowed-origins secret is missing", async () => {
    const handleRoute = await loadRoute({ DENO_DEPLOYMENT_ID: "deployment-1" });

    const blocked = await handleRoute(optionsRequest("https://app.example"));

    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Origin not allowed." });
  });
});
