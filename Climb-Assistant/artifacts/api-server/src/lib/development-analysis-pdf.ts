import PDFDocument from "pdfkit";

type FeedbackConclusion = {
  feedbackPoint?: string;
  laterEvidence?: string;
  status?: string;
  conclusion?: string;
  phase?: string;
};

type DevelopmentReport = {
  reportVersion?: number;
  overallDevelopment?: string;
  climbDevelopment?: {
    narrative?: string;
    feedbackNarrative?: string;
    feedbackConclusions?: FeedbackConclusion[];
  };
  finalAnswerDevelopment?: {
    afterFeedbackOne?: string;
    afterFeedbackTwo?: string;
    overallAnswerDevelopment?: string;
    feedbackConclusions?: FeedbackConclusion[];
  };
  teacherNextSteps?: string[];
  cautions?: string[];
};

type DevelopmentAnalysisPdfInput = {
  studentName: string;
  taskTitle: string;
  generatedAt: Date | string | null;
  report: DevelopmentReport;
  comparisons?: unknown;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const BOTTOM_MARGIN = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export function renderDevelopmentAnalysisPdf(input: DevelopmentAnalysisPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, right: MARGIN, bottom: BOTTOM_MARGIN, left: MARGIN },
      bufferPages: true,
      info: {
        Title: `Development report — ${input.studentName}`,
        Subject: input.taskTitle,
        Author: "The Assisted Climb",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const availableHeight = PAGE_HEIGHT - BOTTOM_MARGIN;
    const ensureSpace = (height = 42) => {
      if (document.y > availableHeight - height) document.addPage();
    };
    const title = (text: string) => {
      ensureSpace(44);
      document.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text(text);
      document.moveDown(0.25);
    };
    const section = (text: string) => {
      document.moveDown(0.7);
      // Keep a heading with some following content without forcing a short
      // final section onto a mostly empty page.
      ensureSpace(50);
      document.font("Helvetica-Bold").fontSize(15).fillColor("#075985").text(text);
      document
        .moveTo(MARGIN, document.y + 5)
        .lineTo(PAGE_WIDTH - MARGIN, document.y + 5)
        .strokeColor("#bae6fd")
        .stroke();
      document.moveDown(0.6);
    };
    const subheading = (text: string) => {
      ensureSpace(48);
      document.moveDown(0.4);
      document.font("Helvetica-Bold").fontSize(11).fillColor("#1f2937").text(text);
      document.moveDown(0.15);
    };
    const paragraph = (text: string, italic = false) => {
      ensureSpace(34);
      document
        .font(italic ? "Helvetica-Oblique" : "Helvetica")
        .fontSize(10)
        .fillColor("#374151")
        .text(text, { width: CONTENT_WIDTH, lineGap: 2.5, characterSpacing: 0, wordSpacing: 0 });
      document.moveDown(0.45);
    };
    const bullets = (items: string[], emptyMessage: string) => {
      if (items.length === 0) {
        paragraph(emptyMessage, true);
        return;
      }
      for (const item of items) {
        ensureSpace(32);
        document
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(`•  ${item}`, { width: CONTENT_WIDTH - 12, indent: 12, lineGap: 2.5, characterSpacing: 0, wordSpacing: 0 });
        document.moveDown(0.3);
      }
    };
    const conclusions = (items: FeedbackConclusion[] | undefined) => {
      if (!items?.length) {
        paragraph("No feedback conclusion was recorded for this section.", true);
        return;
      }
      for (const item of items) {
        const feedback = item.feedbackPoint || "Feedback point unavailable";
        const evidence = item.laterEvidence || "The available evidence is insufficient.";
        const conclusion = [item.status, item.conclusion].filter(Boolean).join(" — ");
        const estimatedHeight =
          document.font("Helvetica").fontSize(10).heightOfString(`Feedback: ${feedback}`, { width: CONTENT_WIDTH })
          + document.heightOfString(`Later evidence: ${evidence}`, { width: CONTENT_WIDTH })
          + document.heightOfString(`Conclusion: ${conclusion}`, { width: CONTENT_WIDTH })
          + 24;
        ensureSpace(Math.min(estimatedHeight, 180));
        document
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor("#111827")
          .text("Feedback", { width: CONTENT_WIDTH, characterSpacing: 0, wordSpacing: 0 });
        document
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#374151")
          .text(feedback, {
            width: CONTENT_WIDTH,
            lineGap: 2.5,
            characterSpacing: 0,
            wordSpacing: 0,
          });
        document.moveDown(0.2);
        document.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("Later evidence");
        document.font("Helvetica").fontSize(10).fillColor("#374151").text(evidence, {
          width: CONTENT_WIDTH, lineGap: 2.5, characterSpacing: 0, wordSpacing: 0,
        });
        document.moveDown(0.2);
        document.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("Conclusion");
        document.font("Helvetica").fontSize(10).fillColor("#374151").text(
          conclusion || "The available evidence is insufficient.",
          { width: CONTENT_WIDTH, lineGap: 2.5, characterSpacing: 0, wordSpacing: 0 },
        );
        document.moveDown(0.6);
      }
    };

    const report = input.report;
    const formative = report.climbDevelopment ?? {};
    const finalAnswers = report.finalAnswerDevelopment ?? {};

    title("Development Report");
    paragraph(`${input.studentName} — ${input.taskTitle}`);
    paragraph(`Generated ${input.generatedAt ? new Date(input.generatedAt).toLocaleString("en-GB") : "date unavailable"}`);
    paragraph(
      "This report examines how the student’s work changed across preserved versions and whether later work contains evidence related to the formative and AI feedback received.",
    );

    section("Overall development");
    paragraph(report.overallDevelopment || "The available evidence is insufficient for an overall interpretation.", true);

    section("Development across the Assisted Climb");
    paragraph(formative.narrative || "The available Assisted Climb evidence is insufficient.");
    subheading("Response to formative feedback");
    paragraph(formative.feedbackNarrative || "The available evidence is insufficient to assess the response to formative feedback.");
    conclusions(formative.feedbackConclusions);

    section("Development across the final answers");
    subheading("After AI feedback one");
    paragraph(finalAnswers.afterFeedbackOne || "The available evidence is insufficient.");
    conclusions(finalAnswers.feedbackConclusions?.filter((item: any) => item.phase === "ai_feedback_one"));
    subheading("After AI feedback two");
    paragraph(finalAnswers.afterFeedbackTwo || "The available evidence is insufficient.");
    conclusions(finalAnswers.feedbackConclusions?.filter((item: any) => item.phase === "ai_feedback_two"));
    subheading("Overall answer development");
    paragraph(finalAnswers.overallAnswerDevelopment || "The available evidence is insufficient.");
    conclusions(finalAnswers.feedbackConclusions?.filter((item: any) => item.phase === "overall"));

    section("Teacher next steps");
    bullets(report.teacherNextSteps ?? [], "No specific next step was identified from the available evidence.");

    section("Cautions and evidence limitations");
    bullets(report.cautions ?? [], "The available evidence may be incomplete and should be reviewed alongside the preserved work.");
    paragraph(
      "The report identifies correspondence between feedback and later changes. It cannot prove causation, improvement or attainment.",
      true,
    );

    const pageRange = document.bufferedPageRange();
    for (let page = pageRange.start; page < pageRange.start + pageRange.count; page += 1) {
      document.switchToPage(page);
      const previousBottomMargin = document.page.margins.bottom;
      document.page.margins.bottom = 0;
      document
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#6b7280")
        .text(`The Assisted Climb · Page ${page + 1} of ${pageRange.count}`, MARGIN, PAGE_HEIGHT - 32, {
          width: CONTENT_WIDTH,
          align: "right",
          lineBreak: false,
        });
      document.page.margins.bottom = previousBottomMargin;
    }
    document.end();
  });
}