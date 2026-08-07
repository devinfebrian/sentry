import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "../../services/importParser";
import { ImportDialog } from "./ImportDialog";

const { previewImportMock } = vi.hoisted(() => ({ previewImportMock: vi.fn() }));

vi.mock("../../workers/importPreview", () => ({ previewImport: previewImportMock }));

const preview: ImportPreview = {
  headers: ["entity", "amount"],
  rows: Array.from({ length: 6 }, (_, index) => ({
    entity: `Entity ${index + 1}`,
    values: { entity: `Entity ${index + 1}`, amount: index + 1 },
    sourceRow: index + 2,
  })),
  warnings: ["Skipped one row without an amount."],
};

const acceptedImport = {
  investigationId: "INV-IMPORTED1",
  uploadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "processing" as const,
  retry: vi.fn(),
};

describe("ImportDialog", () => {
  beforeEach(() => {
    previewImportMock.mockReset();
  });

  it("previews selected files in the Worker and shows five rows and warnings", async () => {
    previewImportMock.mockResolvedValue(preview);
    const user = userEvent.setup();
    const file = new File(["entity,amount\nEntity 1,1"], "ledger.csv", { type: "text/csv" });

    render(<ImportDialog open onClose={vi.fn()} onImported={vi.fn(async () => acceptedImport)} />);

    await user.upload(screen.getByLabelText(/financial data file/i), file);

    expect(previewImportMock).toHaveBeenCalledWith(file, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText("Entity 1")).toBeInTheDocument();
    expect(screen.queryByText("Entity 6")).not.toBeInTheDocument();
    expect(screen.getByText(/Skipped one row without an amount/i)).toBeInTheDocument();
  });

  it("explains up front that a file is required before importing", () => {
    render(<ImportDialog open onClose={vi.fn()} onImported={vi.fn(async () => acceptedImport)} />);

    const action = screen.getByRole("button", { name: "Import data" });
    expect(screen.getByText(/choose a csv, xls, or xlsx file to enable import/i)).toBeInTheDocument();
    // The hint must be programmatically associated, not just visually adjacent.
    expect(action).toHaveAccessibleDescription(/choose a csv, xls, or xlsx file/i);
  });

  it("reports why nothing happened when imported with no file selected", async () => {
    const onImported = vi.fn(async () => acceptedImport);
    const user = userEvent.setup();
    render(<ImportDialog open onClose={vi.fn()} onImported={onImported} />);

    // A disabled primary action swallows the click and leaves the user with no feedback,
    // so the action stays clickable and explains itself instead.
    await user.click(screen.getByRole("button", { name: "Import data" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/choose a csv or spreadsheet file before importing/i);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("keeps the parser reason visible when importing a rejected file", async () => {
    // A .csv the accept filter admits but the parser rejects, matching the real failure.
    previewImportMock.mockRejectedValue(new Error("Missing numeric transaction or value column."));
    const onImported = vi.fn(async () => acceptedImport);
    const user = userEvent.setup();
    const file = new File(["entity,reference\nAcme,R-1"], "ledger.csv", { type: "text/csv" });

    render(<ImportDialog open onClose={vi.fn()} onImported={onImported} />);
    await user.upload(screen.getByLabelText(/financial data file/i), file);
    expect(await screen.findByRole("alert")).toHaveTextContent(/missing numeric transaction or value column/i);

    await user.click(screen.getByRole("button", { name: "Import data" }));

    // The specific reason must survive; it must not be replaced by generic guidance.
    expect(screen.getByRole("alert")).toHaveTextContent(/missing numeric transaction or value column/i);
    expect(onImported).not.toHaveBeenCalled();
  });

  it("awaits async import before closing and returning focus", async () => {
    previewImportMock.mockResolvedValue(preview);
    let resolveImport!: () => void;
    const importPromise = new Promise<void>((resolve) => {
      resolveImport = resolve;
    });
    const onImported = vi.fn(() => importPromise.then(() => acceptedImport));
    const onClose = vi.fn();
    const returnButton = document.createElement("button");
    document.body.append(returnButton);
    const returnFocusRef = { current: returnButton };
    const user = userEvent.setup();
    const file = new File(["data"], "ledger.csv", { type: "text/csv" });

    try {
      render(<ImportDialog open onClose={onClose} onImported={onImported} returnFocusRef={returnFocusRef} />);
      await user.upload(screen.getByLabelText(/financial data file/i), file);
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /import data/i }));

      expect(onImported).toHaveBeenCalledWith(file, preview);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(returnButton).not.toHaveFocus();

      resolveImport();

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(returnButton).not.toHaveFocus();
    } finally {
      returnButton.remove();
    }
  });

  it("keeps dialog open and announces async import errors", async () => {
    previewImportMock.mockResolvedValue(preview);
    const onImported = vi.fn(async () => {
      throw new Error("Unable to create upload: storage denied");
    });
    const user = userEvent.setup();

    render(<ImportDialog open onClose={vi.fn()} onImported={onImported} />);
    await user.upload(screen.getByLabelText(/financial data file/i), new File(["data"], "ledger.csv"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /import data/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/storage denied/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("returns focus to trigger when cancelled", async () => {
    const returnButton = document.createElement("button");
    document.body.append(returnButton);
    const onClose = vi.fn();
    const user = userEvent.setup();

    try {
      render(<ImportDialog open onClose={onClose} onImported={vi.fn(async () => acceptedImport)} returnFocusRef={{ current: returnButton }} />);
      await user.click(screen.getByRole("button", { name: /cancel/i }));

      await waitFor(() => expect(returnButton).toHaveFocus());
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      returnButton.remove();
    }
  });

  it("dismisses on Escape and returns focus to trigger", async () => {
    const returnButton = document.createElement("button");
    document.body.append(returnButton);
    const onClose = vi.fn();
    const user = userEvent.setup();

    try {
      render(<ImportDialog open onClose={onClose} onImported={vi.fn(async () => acceptedImport)} returnFocusRef={{ current: returnButton }} />);
      await user.keyboard("{Escape}");

      expect(onClose).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(returnButton).toHaveFocus());
    } finally {
      returnButton.remove();
    }
  });

  it("traps forward and reverse Tab focus inside aria-modal dialog", async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onClose={vi.fn()} onImported={vi.fn(async () => acceptedImport)} />);
    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: /close/i });
    // The primary action is the last focusable element, so it owns the wrap boundary.
    const importButton = within(dialog).getByRole("button", { name: "Import data" });

    importButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(importButton).toHaveFocus();

    await user.keyboard("{Escape}");
  });

  it("aborts superseded preview and ignores stale result", async () => {
    const deferredPreviews: Array<{ file: File; resolve: (value: ImportPreview) => void; signal: AbortSignal }> = [];
    previewImportMock.mockImplementation((file: File, options: { signal: AbortSignal }) => new Promise<ImportPreview>((resolve) => {
      deferredPreviews.push({ file, resolve, signal: options.signal });
    }));
    const user = userEvent.setup();
    const firstFile = new File(["first"], "first.csv", { type: "text/csv" });
    const secondFile = new File(["second"], "second.csv", { type: "text/csv" });
    const firstPreview = { ...preview, rows: [{ ...preview.rows[0]!, entity: "First entity" }] };
    const secondPreview = { ...preview, rows: [{ ...preview.rows[0]!, entity: "Second entity" }] };

    render(<ImportDialog open onClose={vi.fn()} onImported={vi.fn(async () => acceptedImport)} />);
    await user.upload(screen.getByLabelText(/financial data file/i), firstFile);
    await user.upload(screen.getByLabelText(/financial data file/i), secondFile);

    expect(deferredPreviews[0]?.signal.aborted).toBe(true);
    deferredPreviews[0]?.resolve(firstPreview);
    deferredPreviews[1]?.resolve(secondPreview);

    expect(await screen.findByText("Second entity")).toBeInTheDocument();
    expect(screen.queryByText("First entity")).not.toBeInTheDocument();
  });

  it("aborts pending preview on close without showing cancellation error", async () => {
    let resolvePreview!: (value: ImportPreview) => void;
    let signal!: AbortSignal;
    previewImportMock.mockImplementation((_file: File, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<ImportPreview>((resolve) => {
        resolvePreview = resolve;
      });
    });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<ImportDialog open onClose={onClose} onImported={vi.fn(async () => acceptedImport)} />);
    await user.upload(screen.getByLabelText(/financial data file/i), new File(["data"], "ledger.csv"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    resolvePreview(preview);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
