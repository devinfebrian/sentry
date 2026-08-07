import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { MAX_INPUT_BYTES } from "../../supabase/functions/_shared/parser";
import { parseImportFile } from "./importParser";
import { previewImport } from "../workers/importPreview";

type WorkerMode = "normal" | "constructor-error" | "post-error" | "worker-error" | "message-error" | "silent" | "malformed-error";

let workerMode: WorkerMode = "normal";

class PreviewWorkerMock {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  messages: unknown[] = [];

  postMessage(message: unknown) {
    this.messages.push(message);
    if (workerMode === "post-error") {
      throw new Error("postMessage failed");
    }
    if (workerMode === "worker-error") {
      queueMicrotask(() => this.onerror?.({ message: "worker failed" } as ErrorEvent));
      return;
    }
    if (workerMode === "message-error") {
      queueMicrotask(() => this.onmessageerror?.());
      return;
    }
    if (workerMode === "silent") {
      return;
    }
    if (workerMode === "malformed-error") {
      queueMicrotask(() => this.onmessage?.({ data: { type: "error", message: null } } as MessageEvent));
      return;
    }

    const file = (message as { file: File }).file;
    void parseImportFile(file, 5)
      .then((preview) => this.onmessage?.({ data: { type: "ready", preview } } as MessageEvent))
      .catch((error: unknown) => {
        this.onmessage?.({
          data: { type: "error", message: error instanceof Error ? error.message : String(error) },
        } as MessageEvent);
      });
  }

  terminate() {
    this.terminated = true;
  }
}

let workers: PreviewWorkerMock[] = [];

function makeWorkbookFile(rows: unknown[][], name = "ledger.xlsx") {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Ledger");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function makeCsvFile(rows: unknown[][], name = "ledger.csv") {
  return new File([rows.map((row) => row.join(",")).join("\n")], name, { type: "text/csv" });
}

function makeMalformedZipFile(name = "ledger.xlsx") {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint32(12, 46, true);
  return new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

beforeEach(() => {
  workers = [];
  workerMode = "normal";
  vi.stubGlobal("Worker", class extends PreviewWorkerMock {
    constructor(...args: unknown[]) {
      super();
      if (workerMode === "constructor-error") {
        throw new Error("constructor failed");
      }
      workers.push(this);
      void args;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseImportFile", () => {
  it("normalizes supported spreadsheet rows and numeric values", async () => {
    const result = await parseImportFile(makeWorkbookFile([["Entity", "Amount"], ["Northstar Ltd", "$1,200"]]));
    expect(result.rows).toEqual([
      { entity: "Northstar Ltd", values: { entity: "Northstar Ltd", amount: 1200 }, sourceRow: 2 },
    ]);
  });

  it.each(["12abc", "$1,2x0", "1.2.3"])("rejects malformed numeric value %s with row and header", async (value) => {
    await expect(parseImportFile(makeWorkbookFile([["Entity", "Amount"], ["Northstar", value]]))).rejects.toThrow(
      /Invalid numeric value at row 2, header "amount"/i,
    );
  });

  it("rejects malformed numeric values on rows skipped for blank entity", async () => {
    await expect(parseImportFile(makeWorkbookFile([
      ["Entity", "Amount"],
      ["", "not-a-number"],
      ["Northstar", "10"],
    ]))).rejects.toThrow(/Invalid numeric value at row 2, header "amount"/i);
  });

  it("accepts CSV files", async () => {
    const result = await parseImportFile(new File(["Entity,Total\nOrchid Supply,450"], "ledger.csv", { type: "text/csv" }));
    expect(result.rows[0]?.entity).toBe("Orchid Supply");
  });

  it("rejects unsupported files", async () => {
    await expect(parseImportFile(new File(["data"], "notes.txt"))).rejects.toThrow(/CSV, XLS, or XLSX/i);
  });

  it("requires an entity and numeric value column", async () => {
    await expect(parseImportFile(makeWorkbookFile([["Account"], ["1001"]]))).rejects.toThrow(/entity column/i);
    await expect(parseImportFile(makeWorkbookFile([["Entity", "Description"], ["Northstar", "Invoice"]]))).rejects.toThrow(/numeric transaction/i);
  });

  it("rejects duplicate non-empty normalized headers with an actionable error", async () => {
    await expect(
      parseImportFile(
        makeWorkbookFile([
          ["Entity", "Amount", " amount "],
          ["Northstar", "10", "20"],
        ]),
      ),
    ).rejects.toThrow('Duplicate header "amount". Rename duplicate columns so each header is unique.');
  });

  it("omits blank headers without shifting row values", async () => {
    const result = await parseImportFile(
      makeWorkbookFile([
        ["Entity", "   ", "Amount"],
        ["Northstar", "not a returned value", "10"],
      ]),
    );

    expect(result.headers).toEqual(["entity", "amount"]);
    expect(result.rows[0]).toEqual({
      entity: "Northstar",
      values: { entity: "Northstar", amount: 10 },
      sourceRow: 2,
    });
  });

  it("rejects empty worksheets", async () => {
    await expect(parseImportFile(makeWorkbookFile([["Entity", "Amount"]]))).rejects.toThrow(/No financial records/i);
  });

  it("rejects malformed ZIP metadata before SheetJS expansion", async () => {
    await expect(parseImportFile(makeMalformedZipFile())).rejects.toThrow(/ZIP|archive|central/i);
  });

  // Matrix limits (rows, columns, cells, cell length) and unsafe-numeric rejection belong to
  // the shared parser and are covered against it in supabase/functions/parse-upload/index.test.ts.

  it("preserves exact decimal, currency, comma, and CSV normalization", async () => {
    const xlsxResult = await parseImportFile(makeWorkbookFile([
      ["Entity", "Amount"],
      ["Northstar", "$1,200"],
      ["Orchid", "0.123456789012345"],
    ]));
    const csvResult = await parseImportFile(new File(["Entity,Total\nCedar,\"-2,500.50\""], "ledger.csv", { type: "text/csv" }));

    expect(xlsxResult.rows.map((row) => row.values.amount)).toEqual([1200, 0.123456789012345]);
    expect(csvResult.rows[0]?.values.total).toBe(-2500.5);
  });
});

describe("previewImport", () => {
  it("returns normalized headers, first five rows, and all blank-entity warnings", async () => {
    const result = await previewImport(
      makeCsvFile([
        ["Entity", "Amount"],
        ["Northstar Ltd", "$1200"],
        ["", "25"],
        ["Orchid Supply", "450"],
        ["Pine Holdings", "500"],
        ["Quill Works", "600"],
        ["River Labs", "700"],
        ["Summit Group", "800"],
      ]),
    );

    expect(result.headers).toEqual(["entity", "amount"]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual({
      entity: "Northstar Ltd",
      values: { entity: "Northstar Ltd", amount: 1200 },
      sourceRow: 2,
    });
    expect(result.rows.at(-1)?.entity).toBe("River Labs");
    expect(result.rows.some((row) => row.entity === "Summit Group")).toBe(false);
    expect(result.warnings).toEqual(["Row 3 skipped because Entity is empty."]);
    expect((workers[0]?.messages[0] as { type: string }).type).toBe("preview");
    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects a missing entity header with an actionable message", async () => {
    await expect(previewImport(makeCsvFile([["Account", "Amount"], ["1001", "50"]]))).rejects.toThrow(
      /entity column/i,
    );
    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects a missing numeric transaction or value header", async () => {
    await expect(previewImport(makeCsvFile([["Entity", "Description"], ["Northstar", "Invoice"]]))).rejects.toThrow(
      /numeric transaction/i,
    );
  });

  it("rejects empty files", async () => {
    await expect(previewImport(new File([], "ledger.csv", { type: "text/csv" }))).rejects.toThrow(/file is empty/i);
  });

  it("rejects unsupported extensions", async () => {
    await expect(previewImport(new File(["Entity,Amount\nNorthstar,50"], "ledger.txt"))).rejects.toThrow(
      /CSV, XLS, or XLSX/i,
    );
  });

  it("rejects files larger than 25 MB", async () => {
    await expect(
      previewImport(new File([new Uint8Array(26214401)], "ledger.csv", { type: "text/csv" })),
    ).rejects.toThrow(/25 MB/i);
  });

  it("rejects files with no usable rows", async () => {
    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["", "50"]]))).rejects.toThrow(
      /No usable financial records/i,
    );
  });

  it("rejects cancelled previews before creating a Worker", async () => {
    workerMode = "silent";
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const rejection = expect(
      previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]), { signal: controller.signal }),
    ).rejects.toThrow(/cancel/i);

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    expect(workers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates Worker and removes listeners when cancelled after Worker creation", async () => {
    workerMode = "silent";
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const promise = previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]), { signal: controller.signal });
    const rejection = expect(promise).rejects.toThrow(/cancel/i);

    controller.abort();

    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(workers[0]?.terminated).toBe(true);
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and cleans up when Worker construction fails", async () => {
    workerMode = "constructor-error";
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]), { signal: controller.signal })).rejects.toThrow(
      /start file preview/i,
    );

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and terminates when postMessage fails", async () => {
    workerMode = "post-error";

    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]))).rejects.toThrow(
      /send file for preview/i,
    );

    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects and terminates on Worker errors", async () => {
    workerMode = "worker-error";

    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]))).rejects.toThrow(
      /preview selected file/i,
    );

    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects and terminates on Worker message errors", async () => {
    workerMode = "message-error";

    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]))).rejects.toThrow(
      /receive file preview/i,
    );

    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects malformed Worker error messages with an actionable error", async () => {
    workerMode = "malformed-error";

    await expect(previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]))).rejects.toThrow(
      /valid file preview/i,
    );

    expect(workers[0]?.terminated).toBe(true);
  });

  it("rejects and terminates when preview times out", async () => {
    workerMode = "silent";
    vi.useFakeTimers();
    const promise = previewImport(makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]));
    const rejection = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(workers[0]?.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Driven through parseImportFile rather than the size check directly: the boundary is only
  // meaningful as "what a selected file is allowed to be", and File.size is reported, not read.
  it.each([
    { size: MAX_INPUT_BYTES, label: "accepts exactly 25 MiB", rejects: false },
    { size: MAX_INPUT_BYTES + 1, label: "rejects one byte above 25 MiB", rejects: true },
  ])("$label", async ({ size, rejects }) => {
    const file = makeCsvFile([["Entity", "Amount"], ["Northstar", "50"]]);
    Object.defineProperty(file, "size", { value: size });

    const parsed = parseImportFile(file);
    if (rejects) {
      await expect(parsed).rejects.toThrow(/25 MB/i);
    } else {
      await expect(parsed).resolves.toMatchObject({ rows: [{ entity: "Northstar" }] });
    }
  });
});
