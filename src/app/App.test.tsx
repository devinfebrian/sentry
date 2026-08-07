import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, User } from "@supabase/supabase-js";
import type { ImportPreview } from "../services/importParser";
import { AuthContext, type AuthContextValue } from "../auth/AuthProvider";
import { App } from "./App";

const {
  fakeSupabase,
  previewImportMock,
  createInvestigationServiceMock,
  investigationListMock,
  investigationGetByIdMock,
  createUploadServiceMock,
  investigationCreateMock,
    createUploadMock,
    startParsingMock,
    retryParsingMock,
  } = vi.hoisted(() => {
  const investigationCreateMock = vi.fn();
  const investigationListMock = vi.fn();
  const investigationGetByIdMock = vi.fn();
    const createUploadMock = vi.fn();
    const startParsingMock = vi.fn();
    const retryParsingMock = vi.fn();
  return {
    fakeSupabase: {},
    previewImportMock: vi.fn(),
    createInvestigationServiceMock: vi.fn(() => ({ list: investigationListMock, getById: investigationGetByIdMock, create: investigationCreateMock })),
    investigationListMock,
    investigationGetByIdMock,
    createUploadServiceMock: vi.fn(() => ({ createUpload: createUploadMock, startParsing: startParsingMock, retryParsing: retryParsingMock })),
    investigationCreateMock,
    createUploadMock,
    startParsingMock,
    retryParsingMock,
  };
});

vi.mock("../lib/supabase", () => ({ isSupabaseConfigured: true, supabase: fakeSupabase }));
vi.mock("../workers/importPreview", () => ({ previewImport: previewImportMock }));
vi.mock("../services/sentinelInvestigations", () => ({ createSentinelInvestigationService: createInvestigationServiceMock }));
vi.mock("../services/sentinelUploads", () => ({ createSentinelUploadService: createUploadServiceMock }));

const testUser = { id: "test-user", email: "test@example.com" } as User;
const testSession = { user: testUser } as Session;
const authenticatedAuth = {
  session: testSession,
  user: testUser,
  role: "manager",
  workspaceId: "test-workspace",
  membershipStatus: "active",
  loading: false,
  configurationError: null,
  membershipError: null,
  signIn: async () => null,
  signOut: async () => undefined,
} as AuthContextValue;

function renderAuthenticatedApp() {
  return render(
    <AuthContext.Provider value={authenticatedAuth}>
      <App />
    </AuthContext.Provider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
    previewImportMock.mockReset().mockImplementation(async (file: File) => {
      if (!/\.(csv|xls|xlsx)$/i.test(file.name)) {
        throw new Error("Choose a CSV, XLS, or XLSX financial data file.");
      }
      return {
        headers: ["entity", "amount"],
        rows: [{ entity: "Imported Company", values: { entity: "Imported Company", amount: 1200 }, sourceRow: 2 }],
        warnings: [],
      };
    });
    createInvestigationServiceMock.mockClear();
    createUploadServiceMock.mockClear();
    investigationListMock.mockReset().mockResolvedValue([{
      id: "INV-0248",
      databaseId: "00000000-0000-4000-8000-000000000248",
      entity: "Northstar Ltd",
      owner: "Maya Chen",
      risk: "high",
      stageId: "evidence-review",
      status: "review",
      ageDays: 2,
      lastActivity: "12 min ago",
    }]);
    investigationGetByIdMock.mockReset().mockImplementation(async (id: string) => id === "INV-IMPORTED1" ? {
      id: "INV-IMPORTED1",
      databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entity: "Imported Company",
      owner: "test-user",
      risk: "not-assessed",
      stageId: "not-started",
      status: "open",
      ageDays: 0,
      lastActivity: "2026-08-06T10:00:00.000Z",
      analysisStatus: "not-started",
    } : {
      id: "INV-0248",
      databaseId: "00000000-0000-4000-8000-000000000248",
      entity: "Northstar Ltd",
      owner: "Maya Chen",
      risk: "high",
      stageId: "evidence-review",
      status: "review",
      ageDays: 2,
      lastActivity: "12 min ago",
    });
    investigationCreateMock.mockReset();
    createUploadMock.mockReset();
    startParsingMock.mockReset();
    retryParsingMock.mockReset();
  });

  it("navigates from overview to a case and preserves case step order", async () => {
    renderAuthenticatedApp();
    await userEvent.click(await screen.findByRole("link", { name: /northstar ltd/i }));
    const stepNavigation = screen.getByRole("navigation", { name: /case steps/i });
    expect(within(stepNavigation).getByRole("link", { name: "Summary" })).toBeInTheDocument();
    expect(within(stepNavigation).getByRole("link", { name: "Findings" })).toBeInTheDocument();
    expect(within(stepNavigation).getByRole("link", { name: "Evidence" })).toBeInTheDocument();
    expect(within(stepNavigation).getByRole("link", { name: "Decision" })).toBeInTheDocument();
    expect(within(stepNavigation).getByRole("link", { name: "Report" })).toBeInTheDocument();
  });

  it("rejects unsupported imports with recovery text", async () => {
    renderAuthenticatedApp();
    await userEvent.click(screen.getByRole("button", { name: /import data/i }));
    const file = new File(["data"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText(/financial data file/i), file, { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(/csv, xls, or xlsx/i);
  });

  it("creates persisted investigation and upload, starts parse-upload, then navigates to the case", async () => {
    const preview: ImportPreview = {
      headers: ["entity", "amount"],
      rows: [{ entity: "Imported Company", values: { entity: "Imported Company", amount: 1200 }, sourceRow: 2 }],
      warnings: [],
    };
    const investigation = {
      id: "INV-IMPORTED1",
      databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entity: "Imported Company",
      owner: "test-user",
      risk: "not-assessed" as const,
      stageId: "not-started",
      status: "open" as const,
      ageDays: 0,
      lastActivity: "2026-08-06T10:00:00.000Z",
      analysisStatus: "not-started" as const,
    };
    const upload = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    investigationCreateMock.mockResolvedValue(investigation);
    createUploadMock.mockResolvedValue(upload);
    startParsingMock.mockResolvedValue({ uploadId: upload.id, status: "processing" });
    previewImportMock.mockResolvedValue(preview);
    const user = userEvent.setup();
    const file = new File(["entity,amount\nImported Company,1200"], "ledger.csv", { type: "text/csv" });

    renderAuthenticatedApp();

    expect(createInvestigationServiceMock).toHaveBeenCalledWith(fakeSupabase, { workspaceId: "test-workspace", userId: "test-user" });
    expect(createUploadServiceMock).toHaveBeenCalledWith(fakeSupabase, { workspaceId: "test-workspace", userId: "test-user" });

    await user.click(screen.getByRole("button", { name: /import data/i }));
    await user.upload(screen.getByLabelText(/financial data file/i), file);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /import data/i }));

    await screen.findByText(/upload processing started/i);
    expect(await screen.findByRole("heading", { name: /imported company/i })).toBeInTheDocument();
    expect(investigationCreateMock).toHaveBeenCalledWith({ entity: "Imported Company", ownerId: "test-user" });
    expect(createUploadMock).toHaveBeenCalledWith({ investigationId: investigation.databaseId, file });
    expect(startParsingMock).toHaveBeenCalledWith(upload.id);
    expect(investigationCreateMock.mock.invocationCallOrder[0]).toBeLessThan(createUploadMock.mock.invocationCallOrder[0]);
    expect(createUploadMock.mock.invocationCallOrder[0]).toBeLessThan(startParsingMock.mock.invocationCallOrder[0]);
    expect(window.location.pathname).toBe(`/cases/${investigation.id}/summary`);
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it.each(["/evidence", "/reports", "/operations"])("does not expose fixture module at %s in production routes", async (path) => {
    window.history.pushState({}, "", path);

    renderAuthenticatedApp();

    expect(await screen.findByRole("heading", { name: /analysis not started/i })).toBeInTheDocument();
    expect(screen.queryByText("Beneficiary mismatch warrants enhanced review before payment release.")).not.toBeInTheDocument();
    expect(screen.queryByText("Northstar Ltd requires enhanced review before payment release.")).not.toBeInTheDocument();
  });

  it("exposes fixture pages only under the explicit demo route in DEV", async () => {
    window.history.pushState({}, "", "/demo/evidence");

    renderAuthenticatedApp();

    expect(await screen.findByRole("heading", { name: "Evidence" })).toBeInTheDocument();
    expect(screen.getByText(/Three payments share a beneficiary account/i)).toBeInTheDocument();
  });

  it("keeps existing investigation and upload identity when parser start fails, then retries same upload", async () => {
    const investigation = {
      id: "INV-IMPORTED1",
      databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entity: "Imported Company",
      owner: "test-user",
      risk: "not-assessed" as const,
      stageId: "not-started",
      status: "open" as const,
      ageDays: 0,
      lastActivity: "2026-08-06T10:00:00.000Z",
      analysisStatus: "not-started" as const,
    };
    const upload = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    investigationCreateMock.mockResolvedValue(investigation);
    createUploadMock.mockResolvedValue(upload);
    startParsingMock.mockRejectedValue(new Error("Parser unavailable"));
    retryParsingMock.mockResolvedValue({ uploadId: upload.id, status: "processing" });
    const user = userEvent.setup();
    const file = new File(["entity,amount\nImported Company,1200"], "ledger.csv", { type: "text/csv" });

    renderAuthenticatedApp();
    await user.click(screen.getByRole("button", { name: /import data/i }));
    await user.upload(screen.getByLabelText(/financial data file/i), file);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /import data/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/parser unavailable/i);
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: /retry parsing/i })).toBeInTheDocument();
    expect(investigationCreateMock).toHaveBeenCalledTimes(1);
    expect(createUploadMock).toHaveBeenCalledTimes(1);
    expect(startParsingMock).toHaveBeenCalledWith(upload.id);

    await user.click(screen.getByRole("button", { name: /retry parsing/i }));

    expect(retryParsingMock).toHaveBeenCalledWith(upload.id);
    expect(investigationCreateMock).toHaveBeenCalledTimes(1);
    expect(createUploadMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: /imported company/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/cases/${investigation.id}/summary`);
  });

  it("keeps existing investigation and upload identity when Storage upload fails, then retries the existing file", async () => {
    const investigation = {
      id: "INV-IMPORTED1",
      databaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entity: "Imported Company",
      owner: "test-user",
      risk: "not-assessed" as const,
      stageId: "not-started",
      status: "open" as const,
      ageDays: 0,
      lastActivity: "2026-08-06T10:00:00.000Z",
      analysisStatus: "not-started" as const,
    };
    const upload = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const retryUpload = vi.fn().mockResolvedValue(upload);
    investigationCreateMock.mockResolvedValue(investigation);
    createUploadMock.mockRejectedValue({
      message: "Unable to upload file: storage denied",
      recovery: {
        kind: "sentinel-upload-recovery",
        investigationId: investigation.databaseId,
        uploadId: upload.id,
        retryUpload,
      },
    });
    startParsingMock.mockResolvedValue({ uploadId: upload.id, status: "processing" });
    const user = userEvent.setup();
    const file = new File(["entity,amount\nImported Company,1200"], "ledger.csv", { type: "text/csv" });

    renderAuthenticatedApp();
    await user.click(screen.getByRole("button", { name: /import data/i }));
    await user.upload(screen.getByLabelText(/financial data file/i), file);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /import data/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/storage denied/i);
    expect(screen.getByText(/upload .* retained/i)).toBeInTheDocument();
    expect(investigationCreateMock).toHaveBeenCalledTimes(1);
    expect(createUploadMock).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    // The primary action stays clickable so it can explain itself, but re-importing after a
    // failure must not create a second investigation or upload; Retry owns that path.
    await user.click(within(dialog).getByRole("button", { name: /^import data$/i }));
    expect(investigationCreateMock).toHaveBeenCalledTimes(1);
    expect(createUploadMock).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: /retry upload/i }));

    expect(retryUpload).toHaveBeenCalledTimes(1);
    expect(startParsingMock).toHaveBeenCalledWith(upload.id);
    expect(investigationCreateMock).toHaveBeenCalledTimes(1);
    expect(createUploadMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: /imported company/i })).toBeInTheDocument();
  });

  it("returns import cancellation focus to Cases route trigger", async () => {
    window.history.pushState({}, "", "/cases");
    renderAuthenticatedApp();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: /import data/i });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("redirects unauthenticated workspace routes to sign-in without the AppShell", async () => {
    window.history.pushState({}, "", "/cases");
    render(
      <AuthContext.Provider value={{ ...authenticatedAuth, session: null, user: null, role: null, workspaceId: null }}>
        <App />
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByText("FinAI / workspace")).not.toBeInTheDocument();
  });

  it("shows workspace access pending for authenticated users without active membership", async () => {
    window.history.pushState({}, "", "/cases");
    render(
      <AuthContext.Provider value={{ ...authenticatedAuth, role: null, workspaceId: null, membershipStatus: "pending" } as AuthContextValue}>
        <App />
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole("heading", { name: /workspace access pending/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("shows access denied for authenticated users without membership", async () => {
    window.history.pushState({}, "", "/cases");
    render(
      <AuthContext.Provider value={{ ...authenticatedAuth, role: null, workspaceId: null, membershipStatus: "missing" } as AuthContextValue}>
        <App />
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole("heading", { name: /workspace access denied/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /workspace access pending/i })).not.toBeInTheDocument();
  });
});
