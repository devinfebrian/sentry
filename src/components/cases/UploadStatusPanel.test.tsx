import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ImportRow, SentinelUpload } from "../../domain/types";
import { UploadStatusPanel } from "./UploadStatusPanel";

const investigationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uploadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function upload(status: SentinelUpload["status"], overrides: Partial<SentinelUpload> = {}): SentinelUpload {
  return { id: uploadId, investigationId, status, rowCount: 0, warnings: [], errorMessage: null, ...overrides };
}

const rows: ImportRow[] = [
  { entity: "Northstar Ltd", values: { entity: "Northstar Ltd", amount: 1200 }, sourceRow: 2 },
  { entity: "Orchid Supply", values: { entity: "Orchid Supply", amount: 450 }, sourceRow: 3 },
];

function service(latest: SentinelUpload | null, overrides: Partial<{
  listRows: () => Promise<ImportRow[]>;
  retryParsing: () => Promise<never>;
}> = {}) {
  return {
    getLatestForInvestigation: vi.fn(async () => latest),
    getStatus: vi.fn(async () => latest as SentinelUpload),
    listRows: vi.fn(overrides.listRows ?? (async () => rows)),
    retryParsing: vi.fn(overrides.retryParsing ?? (async () => ({ uploadId, status: "processing" as const }))),
  };
}

describe("UploadStatusPanel", () => {
  it("renders nothing when the investigation has no upload", async () => {
    const { container } = render(<UploadStatusPanel investigationId={investigationId} uploadService={service(null)} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows the row count, warnings, and a bounded preview once parsed", async () => {
    const uploads = service(upload("parsed", { rowCount: 42, warnings: ["Row 7 skipped because Entity is empty."] }));
    render(<UploadStatusPanel investigationId={investigationId} uploadService={uploads} />);

    expect(await screen.findByText("42 records imported")).toBeInTheDocument();
    expect(screen.getByText(/1 row warning\(s\) were skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/Row 7 skipped because Entity is empty/i)).toBeInTheDocument();
    // The preview must say it is a preview, not imply the whole import is on screen.
    expect(screen.getByText("First 2 of 42")).toBeInTheDocument();
    expect(screen.getByText("Northstar Ltd")).toBeInTheDocument();
  });

  it("uses singular wording for a one-row import", async () => {
    render(<UploadStatusPanel investigationId={investigationId} uploadService={service(upload("parsed", { rowCount: 1 }))} />);

    expect(await screen.findByText("1 record imported")).toBeInTheDocument();
  });

  it("reports a parse failure with its reason and offers a retry", async () => {
    const uploads = service(upload("failed", { errorMessage: "Unable to parse upload. You can retry this upload." }));
    render(<UploadStatusPanel investigationId={investigationId} uploadService={uploads} />);

    expect(await screen.findByRole("heading", { name: /could not be parsed/i })).toBeInTheDocument();
    expect(screen.getByText(/you can retry this upload/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry parsing/i }));
    expect(uploads.retryParsing).toHaveBeenCalledWith(uploadId);
  });

  it("surfaces a failed retry instead of silently doing nothing", async () => {
    const uploads = service(upload("failed", { errorMessage: "Parser failed." }), {
      retryParsing: async () => {
        throw new Error("Unable to retry parsing: denied");
      },
    });
    render(<UploadStatusPanel investigationId={investigationId} uploadService={uploads} />);

    await screen.findByRole("heading", { name: /could not be parsed/i });
    await userEvent.click(screen.getByRole("button", { name: /retry parsing/i }));

    expect(await screen.findByText(/unable to retry parsing: denied/i)).toBeInTheDocument();
  });

  it("shows a parsing state while the parser still owns the upload", async () => {
    render(<UploadStatusPanel investigationId={investigationId} uploadService={service(upload("processing"))} />);

    expect(await screen.findByRole("heading", { name: /parsing source data/i })).toBeInTheDocument();
  });

  it("does not read rows for an upload that is still parsing", async () => {
    const uploads = service(upload("processing"));
    render(<UploadStatusPanel investigationId={investigationId} uploadService={uploads} />);

    await screen.findByRole("heading", { name: /parsing source data/i });
    expect(uploads.listRows).not.toHaveBeenCalled();
  });
});
