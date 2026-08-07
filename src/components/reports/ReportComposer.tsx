import { useState } from "react";
import type { ReportSection } from "../../domain/types";
import { Button } from "../ui/Button";
import { ReportPreview } from "./ReportPreview";

interface ReportComposerProps {
  sections: ReportSection[];
  onExport?: (sections: ReportSection[]) => void;
}

export function ReportComposer({ sections: initialSections, onExport }: ReportComposerProps) {
  const [sections, setSections] = useState(initialSections);
  const [activeSection, setActiveSection] = useState(initialSections[0]?.id ?? "executive-summary");
  const [dirty, setDirty] = useState(false);

  const updateSection = (id: ReportSection["id"], content: string) => {
    setSections((current) => current.map((section) => section.id === id ? { ...section, content } : section));
    setDirty(true);
  };

  return (
    <section className="report-composer" aria-labelledby="report-composer-title">
      <div className="report-composer-header"><div><span className="section-kicker">Reports / structured output</span><h2 id="report-composer-title">Report composer</h2><p>Build a reviewed record from evidence, findings, and decision history.</p></div><div className="report-composer-actions"><span className={dirty ? "unsaved-indicator" : "saved-indicator"} role="status">{dirty ? "Unsaved changes" : "All changes saved"}</span><Button variant="primary" onClick={() => onExport?.(sections)}>Export PDF</Button></div></div>
      <div className="report-composer-layout">
        <nav className="report-section-nav" aria-label="Report sections">
          <span className="section-kicker">Sections</span>
          {sections.map((section, index) => <button type="button" className={activeSection === section.id ? "report-section-nav-item report-section-nav-active" : "report-section-nav-item"} aria-current={activeSection === section.id ? "step" : undefined} onClick={() => setActiveSection(section.id)} key={section.id}><span className="numeric">{String(index + 1).padStart(2, "0")}</span><span>{section.title}</span></button>)}
        </nav>
        <div className="report-edit-panel">
          {sections.map((section) => <section className={`report-edit-section ${activeSection === section.id ? "report-edit-section-active" : ""}`} key={section.id}><div className="report-edit-section-heading"><span className="numeric">{section.id}</span><h3>{section.title}</h3></div>{section.isEditable ? <textarea aria-label={section.title} value={section.content} onChange={(event) => updateSection(section.id, event.target.value)} /> : <p className="report-readonly">{section.content}</p>}</section>)}
        </div>
        <ReportPreview sections={sections} />
      </div>
    </section>
  );
}
