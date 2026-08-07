import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadSupabaseModule() {
  vi.resetModules();
  return import("./supabase");
}

describe("Supabase configuration", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not create a client when public Supabase environment is absent", async () => {
    const { isSupabaseConfigured, supabase } = await loadSupabaseModule();

    expect(isSupabaseConfigured).toBe(false);
    expect(supabase).toBeNull();
  });

  it("does not create a client when only one public Supabase environment variable is present", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://your-sentinel-project.supabase.co");

    const { isSupabaseConfigured, supabase } = await loadSupabaseModule();

    expect(isSupabaseConfigured).toBe(false);
    expect(supabase).toBeNull();
  });
});
