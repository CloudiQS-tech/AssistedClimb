import PDFDocument from "pdfkit";

type JourneyReport = {
  generatedAt?: string | null;
  evidenceCoverage?: Record<string, unknown>;
  formativeToSummativeChanges?: Record<string, unknown>;
  responseToFormativeFeedback?: Record<string, unknown>;
  feedbackMarkedAsActioned?: Record<string, unknown>;
  responseToAiFeedback?: Record<string, unknown>;
  classSimilarities?: string[];
  notableDifferences?: string[];
  activityContext?: Record<string, unknown>;
  reflectionAndFuturePlanning?: string[];
  evidenceLimitations?: string[];
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export function renderClassJourneyAnalysisPdf(input: {
  className: string;
  taskTitle: string;
  report: JourneyReport;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, right: MARGIN, bottom: 64, left: MARGIN },
      bufferPages: true,
      info: {
        Title: `Class Journey Analysis — ${input.className}`,
        Subject: input.taskTitle,
        Author: "The Assisted Climb",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const ensureSpace = (height = 44) => {
      if (document.y > PAGE_HEIGHT - 64 - height) document.addPage();
    };
    const heading = (text: string) => {
      ensureSpace(54);
      document.moveDown(0.5).font("Helvetica-Bold").fontSize(14).fillColor("#075985").text(text);
      document.moveDown(0.25);
    };
    const paragraph = (text: string) => {
      ensureSpace(30);
      document.font("Helvetica").fontSize(10).fillColor("#374151").text(text, {
        width: CONTENT_WIDTH,
        lineGap: 2.5,
      });
      document.moveDown(0.35);
    };
    const bullets = (items: unknown[] | undefined) => {
      if (!items?.length) {
        paragraph("No additional finding was recorded.");
        return;
      }
      for (const item of items) {
        paragraph(`• ${String(item)}`);
      }
    };
    const jsonSummary = (value: Record<string, unknown> | undefined) =>
      Object.entries(value ?? {})
        .filter(([, item]) => typeof item !== "object" || item === null)
        .map(([key, item]) => `${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}: ${String(item)}`)
        .join(" · ");

    document.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text("Class Journey Analysis");
    document.moveDown(0.25);
    document.font("Helvetica-Bold").fontSize(11).fillColor("#374151").text(input.className);
    document.font("Helvetica").fontSize(10).fillColor("#6b7280").text(input.taskTitle);
    paragraph(`Generated ${input.report.generatedAt ? new Date(input.report.generatedAt).toLocaleString("en-GB") : "date unavailable"}`);

    heading("Evidence coverage");
    paragraph(jsonSummary(input.report.evidenceCoverage));
    heading("Formative-to-summative changes");
    paragraph(jsonSummary(input.report.formativeToSummativeChanges));
    bullets((input.report.formativeToSummativeChanges?.findings as unknown[] | undefined));
    heading("Response to formative feedback");
    paragraph(jsonSummary(input.report.responseToFormativeFeedback));
    bullets((input.report.responseToFormativeFeedback?.findings as unknown[] | undefined));
    heading("Feedback marked as actioned");
    paragraph(jsonSummary(input.report.feedbackMarkedAsActioned));
    heading("Response to AI feedback");
    paragraph(jsonSummary(input.report.responseToAiFeedback));
    bullets((input.report.responseToAiFeedback?.findings as unknown[] | undefined));
    heading("Class similarities");
    bullets(input.report.classSimilarities);
    heading("Notable differences");
    bullets(input.report.notableDifferences);
    heading("Activity context");
    paragraph(jsonSummary(input.report.activityContext));
    heading("Reflection and future planning");
    bullets(input.report.reflectionAndFuturePlanning);
    heading("Evidence limitations");
    bullets(input.report.evidenceLimitations);

    const pageRange = document.bufferedPageRange();
    for (let page = pageRange.start; page < pageRange.start + pageRange.count; page += 1) {
      document.switchToPage(page);
      document.font("Helvetica").fontSize(8).fillColor("#6b7280").text(
        `The Assisted Climb · Page ${page + 1} of ${pageRange.count}`,
        MARGIN,
        PAGE_HEIGHT - 32,
        { width: CONTENT_WIDTH, align: "right", lineBreak: false },
      );
    }
    document.end();
  });
}