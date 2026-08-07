import type { ReportSection } from "../../domain/types";

interface ReportPreviewProps {
  sections: ReportSection[];
  title?: string;
}

export function ReportPreview({ sections, title = "Northstar Ltd / Investigation report" }: ReportPreviewProps) {
  return (
    <article className="report-preview" aria-label="Report preview">
      <header className="report-preview-header"><span className="report-logo">F</span><div><span className="section-kicker">FinAI / Finance intelligence</span><p className="numeric">INV-0248 / 05 AUG 2026</p></div></header>
      <div className="report-preview-title"><span className="eyebrow">Investigation report</span><h2>{title}</h2><p>Prepared for Finance operations / Review status: pending approval</p></div>
      <div className="report-preview-sections">
        {sections.map((section) => <section key={section.id}><h3>{section.title}</h3><p>{section.content || "No content added yet."}</p></section>)}
      </div>
      <footer className="report-preview-footer"><span>Confidential / Internal finance use</span><span className="numeric">Page 1</span></footer>
    </article>
  );
}
