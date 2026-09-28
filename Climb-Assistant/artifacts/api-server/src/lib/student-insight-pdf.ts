import PDFDocument from "pdfkit";

type StudentInsight = {
  phase?: "formative" | "summative";
  purposeVersion?: string;
  generatedAt?: string;
  promptVersion?: string;
  aiProvider?: string;
  model?: string;
  provenance?: {
    phase?: string;
    generatedAt?: string;
    promptVersion?: string;
    aiProvider?: string;
    model?: string;
    formativeSnapshotId?: number | null;
    summativeSnapshotId?: number | null;
    sourceRecordIds?: Record<string, unknown>;
  };
  evidenceBoundary?: {
    statement?: string;
    messages?: { available?: number; supplied?: number; maxItems?: number; maxCharactersPerMessage?: number; limited?: boolean };
    researchEntries?: { available?: number; supplied?: number; maxItems?: number; limited?: boolean };
    stageEvidence?: { maxCharactersPerStage?: number; limited?: boolean };
    answers?: { available?: number; maxCharactersPerAnswerExcerpt?: number; limited?: boolean };
    feedback?: { maxCharactersPerComment?: number; limited?: boolean };
    supportingMaterialsExcludedFromProviderPayload?: boolean;
  };
  stageEvidenceProfile?: Array<{
    stage?: string;
    visited?: boolean;
    markedComplete?: boolean;
    substantiveEvidenceRecorded?: boolean;
    learningEvidenceStatus?: string;
    learningEvidence?: string;
  }>;
  activitySectionTiming?: Array<{ stage?: string; label?: string; recordedSeconds?: number }>;
  summary?: string;
  thinkingChoices?: { summary?: string };
  howItCameTogether?: string;
  activitySummary?: string;
  aiUseSummary?: string;
  formativeFollowUp?: string;
  formativeFeedbackConclusions?: Array<{
    feedbackStage?: string;
    feedback?: string;
    status?: string;
    studentAcknowledged?: boolean;
    conclusion?: string;
  }>;
  otherRecordedDevelopment?: string[];
  teacherReviewNotes?: string[];
  responseToAiFeedback?: {
    afterFeedbackOneSummary?: string;
    afterFeedbackOne?: string;
    feedbackOneStatus?: string;
    feedbackOneConclusions?: Array<{
      feedbackPoint?: string;
      laterEvidence?: string;
      status?: string;
      conclusion?: string;
      evidenceReferenceIds?: string[];
      evidenceReferences?: Array<{ id?: string; excerpt?: string }>;
    }>;
    afterFeedbackTwoSummary?: string;
    afterFeedbackTwo?: string;
    feedbackTwoStatus?: string;
    feedbackTwoConclusions?: Array<{
      feedbackPoint?: string;
      laterEvidence?: string;
      status?: string;
      conclusion?: string;
      evidenceReferenceIds?: string[];
      evidenceReferences?: Array<{ id?: string; excerpt?: string }>;
    }>;
    overallAnswerDevelopment?: string;
    unresolved?: string[];
    teacherReview?: string[];
    supportingEvidence?: string[];
    evidenceCautions?: string[];
  };
  strengths?: string[];
  nextSteps?: string[];
  cautions?: string[];
  progressBreakdown?: {
    addressed?: string[];
    partlyAddressed?: string[];
    stillToDevelop?: string[];
  };
  activityComparison?: {
    formativeGeneratedAt?: string | null;
    atFormative?: ActivityComparisonTotals;
    sinceFormative?: ActivityComparisonTotals;
    summativeTotal?: ActivityComparisonTotals;
    finalAnswerFeedbackRoundsUsed?: number | null;
    changedStages?: string[];
  };
  metrics?: {
    totalSessions?: number;
    totalSeconds?: number;
    loginSessionsAvailable?: boolean;
    loginSessionCount?: number | null;
    studentMessages?: number;
    assistantMessages?: number;
  };
};

type ActivityComparisonTotals = {
  recordedSessions?: number | null;
  recordedSeconds?: number | null;
  torchQuestions?: number | null;
  torchResponses?: number | null;
};

const formatDuration = (value: number | undefined) => {
  const total = Math.max(0, Math.round(value ?? 0));
  const minutes = Math.round(total / 60);
  if (minutes < 1) return "0 minutes";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes
    ? `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
};

const formatReadableDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }) : "Not available";

const feedbackStatusLabel = (value: string | undefined) => ({
  acted_upon: "Addressed",
  partly_acted_upon: "Partly addressed",
  no_related_change: "No related change found",
  not_enough_evidence: "Not enough evidence",
  teacher_review_needed: "Teacher review needed",
  no_action_requested: "No action requested",
}[value ?? ""] ?? "Not enough evidence");
const learningEvidenceStatusLabel = (value: string | undefined) => ({
  demonstrated: "Demonstrated",
  partly_demonstrated: "Partly demonstrated",
  not_demonstrated: "Not demonstrated in recorded evidence",
  not_assessable: "Not assessable from recorded evidence",
}[value ?? ""] ?? "Not assessable from recorded evidence");
const HISTORICAL_PROVENANCE_UNAVAILABLE = "Provenance information not available for this previously generated Insight.";

export function renderStudentInsightPdf(input: {
  studentName: string;
  taskTitle: string;
  insight: StudentInsight;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const phase = input.insight.phase === "summative" ? "Summative" : "Formative";
    const pageMargin = phase === "Formative" ? 44 : 48;
    const document = new PDFDocument({
      size: "A4",
      margins: {
        top: phase === "Formative" ? 42 : 48,
        right: pageMargin,
        bottom: phase === "Formative" ? 58 : 64,
        left: pageMargin,
      },
      bufferPages: true,
      info: {
        Title: `${input.insight.phase === "summative" ? "Summative" : "Formative"} Student Insight — ${input.studentName}`,
        Subject: input.taskTitle,
        Author: "The Assisted Climb",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const width = phase === "Formative" ? 507 : 499;
    const contentBottom = phase === "Formative" ? 758 : 742;
    const lineGap = phase === "Formative" ? 1.5 : 2.5;
    const bodyFontSize = phase === "Formative" ? 9.5 : 10;
    const ensureSpace = (height = 50) => {
      if (document.y > contentBottom - height) document.addPage();
    };
    const heading = (text: string) => {
      // Reserve enough room for the first paragraph so a section heading is
      // never stranded at the bottom of a page.
      ensureSpace(phase === "Formative" ? 54 : 64);
      document.moveDown(phase === "Formative" ? 0.25 : 0.4).font("Helvetica-Bold").fontSize(14).fillColor("#047857").text(text);
      document.moveDown(phase === "Formative" ? 0.1 : 0.2);
    };
    const paragraph = (text: unknown) => {
      if (!text) return;
      document.font("Helvetica").fontSize(bodyFontSize);
      ensureSpace(document.heightOfString(String(text), { width, lineGap }) + 10);
      document.fillColor("#374151")
        .text(String(text), { width, lineGap, characterSpacing: 0, wordSpacing: 0 });
      document.moveDown(phase === "Formative" ? 0.1 : 0.2);
    };
    const bullets = (items: unknown) => {
      if (!Array.isArray(items) || !items.length) {
        paragraph("No additional points recorded.");
        return;
      }
      for (const item of items) {
        document.font("Helvetica").fontSize(bodyFontSize);
        ensureSpace(document.heightOfString(`•  ${String(item)}`, { width: width - 12, indent: 12, lineGap }) + 8);
        document.fillColor("#374151")
          .text(`•  ${String(item)}`, { width: width - 12, indent: 12, lineGap, characterSpacing: 0, wordSpacing: 0 });
        document.moveDown(phase === "Formative" ? 0.08 : 0.15);
      }
    };

    document.font("Helvetica-Bold").fontSize(21).fillColor("#111827").text(`${phase} Student Insight`);
    document.moveDown(0.25);
    document.font("Helvetica-Bold").fontSize(11).fillColor("#374151").text(input.studentName);
    document.font("Helvetica").fontSize(bodyFontSize).fillColor("#6b7280").text(input.taskTitle);
    if (input.insight.generatedAt) {
      document.text(`Generated ${new Date(input.insight.generatedAt).toLocaleString("en-GB")}`);
    }
    document.moveDown(phase === "Formative" ? 0.5 : 0.7);

    const metrics = input.insight.metrics ?? {};
    paragraph(
      `Recorded activity sessions: ${metrics.totalSessions ?? "Not available"}   |   Recorded time: ${formatDuration(metrics.totalSeconds)}   |   TORCH AI questions: ${metrics.studentMessages ?? 0}   |   TORCH AI responses: ${metrics.assistantMessages ?? 0}`,
    );
    heading("Recorded time by Climb section");
    if (Array.isArray(input.insight.activitySectionTiming) && input.insight.activitySectionTiming.length > 0) {
      paragraph(input.insight.activitySectionTiming
        .map((entry) => `${entry.label ?? entry.stage ?? "Section"}: ${formatDuration(entry.recordedSeconds)}`)
        .join("   |   "));
    } else {
      paragraph("Not available from this saved report.");
    }
    paragraph("Section times are rounded to whole minutes and may not sum exactly to the total.");
    if (phase !== "Formative") {
      heading("Research metadata");
      if (!input.insight.provenance || typeof input.insight.provenance !== "object") {
        paragraph(HISTORICAL_PROVENANCE_UNAVAILABLE);
      } else {
        paragraph([
          `Phase: ${input.insight.provenance.phase ?? input.insight.phase ?? "Not available"}`,
          `Prompt version: ${input.insight.provenance.promptVersion ?? HISTORICAL_PROVENANCE_UNAVAILABLE}`,
          `AI provider: ${input.insight.provenance.aiProvider ?? HISTORICAL_PROVENANCE_UNAVAILABLE}`,
          `Model: ${input.insight.provenance.model ?? HISTORICAL_PROVENANCE_UNAVAILABLE}`,
          `Formative snapshot: ${input.insight.provenance.formativeSnapshotId ?? "Not used"}`,
          `Summative snapshot: ${input.insight.provenance.summativeSnapshotId ?? "Not used"}`,
        ].join("   |   "));
        paragraph("Full source-record IDs are retained in the downloadable research CSV.");
      }
    }
    heading("Feature-use profile");
    if (Array.isArray(input.insight.stageEvidenceProfile) && input.insight.stageEvidenceProfile.length > 0) {
      for (const item of input.insight.stageEvidenceProfile) {
        paragraph([
          `${item.stage ?? "Stage"} — Visited: ${item.visited ? "Yes" : "No"}`,
          `Marked complete: ${item.markedComplete ? "Yes" : "No"}`,
          `Substantive evidence recorded: ${item.substantiveEvidenceRecorded ? "Yes" : "No"}`,
          `Learning demonstrated: ${learningEvidenceStatusLabel(item.learningEvidenceStatus)}`,
        ].join("   |   "));
        paragraph(`Learning evidence: ${item.learningEvidence ?? "Not available from this saved report."}`);
      }
    } else {
      paragraph("The saved report does not include a separate feature-use profile.");
    }
    if (phase === "Summative") {
      const comparison = input.insight.activityComparison;
      const value = (item: ActivityComparisonTotals | undefined, key: keyof ActivityComparisonTotals, duration = false) => {
        const raw = item?.[key];
        if (typeof raw !== "number") return "Not available";
        return duration ? formatDuration(raw) : String(raw);
      };
      heading("Activity before and after the Formative Insight");
      paragraph(`Formative Insight date: ${formatReadableDate(comparison?.formativeGeneratedAt)}`);
      paragraph(
        `Measure                         At Formative Insight   Since Formative Insight   Summative total\n`
        + `Login sessions                 ${value(comparison?.atFormative, "recordedSessions")}                 ${value(comparison?.sinceFormative, "recordedSessions")}                       ${value(comparison?.summativeTotal, "recordedSessions")}\n`
        + `Recorded active time           ${value(comparison?.atFormative, "recordedSeconds", true)}                 ${value(comparison?.sinceFormative, "recordedSeconds", true)}                       ${value(comparison?.summativeTotal, "recordedSeconds", true)}\n`
        + `TORCH AI questions             ${value(comparison?.atFormative, "torchQuestions")}                 ${value(comparison?.sinceFormative, "torchQuestions")}                       ${value(comparison?.summativeTotal, "torchQuestions")}\n`
        + `TORCH AI responses             ${value(comparison?.atFormative, "torchResponses")}                 ${value(comparison?.sinceFormative, "torchResponses")}                       ${value(comparison?.summativeTotal, "torchResponses")}`,
      );
      paragraph("Recorded activity means interaction recorded inside the Climb; it is not total time spent on the task.");
      heading("Where the work changed");
      paragraph(`Stages changed since formative: ${comparison?.changedStages?.length ? comparison.changedStages.join(", ") : "Not available"}.`);
      paragraph(`Main recorded development: ${input.insight.formativeFollowUp || "Not available from this saved report."}`);
      paragraph(`Final-answer AI-feedback rounds used: ${typeof comparison?.finalAnswerFeedbackRoundsUsed === "number" ? `${comparison.finalAnswerFeedbackRoundsUsed} out of 2` : "Not available"}.`);
    }
    const journeyFormat = input.insight.purposeVersion === "journey-v2";
    heading(phase === "Formative" && journeyFormat ? "Journey at the formative point" : phase === "Summative" ? "Journey comparison" : "Overall interpretation");
    paragraph(input.insight.summary);
    if (input.insight.thinkingChoices) {
      heading("Thinking Choices");
      paragraph(input.insight.thinkingChoices.summary ?? "No thinking-choice data was recorded.");
    }
    heading(phase === "Formative" && journeyFormat ? "Use of the Climb" : phase === "Summative" ? "Formative to completed journey" : "How it came together");
    paragraph(input.insight.howItCameTogether);
    heading("Recorded activity");
    paragraph(input.insight.activitySummary);
    heading("Use of AI");
    paragraph(input.insight.aiUseSummary);
    heading(input.insight.phase === "summative" ? "Progress since the Formative Insight" : journeyFormat ? "Research and verification" : "Formative follow-up");
    paragraph(input.insight.formativeFollowUp);
    if (phase === "Summative" && Array.isArray(input.insight.formativeFeedbackConclusions) && input.insight.formativeFeedbackConclusions.length > 0) {
      heading("Response to teacher formative feedback");
      for (const item of input.insight.formativeFeedbackConclusions) {
        paragraph(`Stage: ${item.feedbackStage ?? ""}`);
        paragraph(`Feedback: ${item.feedback ?? "The preserved feedback text is not available in this saved report."}`);
         paragraph(`Status: ${feedbackStatusLabel(item.status)}`);
         if (typeof item.studentAcknowledged === "boolean") {
           paragraph(`Student marked feedback as actioned: ${item.studentAcknowledged ? "Yes" : "No"}`);
         }
        paragraph(`Later evidence: ${item.conclusion ?? ""}`);
      }
    }
    if (phase === "Summative") {
      heading("Other recorded development");
      bullets(input.insight.otherRecordedDevelopment);
      if (Array.isArray(input.insight.teacherReviewNotes) && input.insight.teacherReviewNotes.length > 0) {
        heading("Teacher review");
        bullets(input.insight.teacherReviewNotes);
      }
    }
    if (input.insight.phase === "summative" && input.insight.responseToAiFeedback) {
      const response = input.insight.responseToAiFeedback;
      heading("Response to AI feedback");
      paragraph(response.overallAnswerDevelopment);
      heading("After AI feedback one");
      paragraph(response.afterFeedbackOneSummary ?? response.afterFeedbackOne);
      heading("After AI feedback two");
      paragraph(response.afterFeedbackTwoSummary ?? response.afterFeedbackTwo);
      for (const [title, conclusions] of [
        ["Feedback one — point-by-point conclusions", response.feedbackOneConclusions],
        ["Feedback two — point-by-point conclusions", response.feedbackTwoConclusions],
      ] as const) {
        if (!Array.isArray(conclusions) || conclusions.length === 0) continue;
        heading(title);
        for (const item of conclusions) {
          const evidence = Array.isArray(item.evidenceReferences)
            ? item.evidenceReferences.map((reference) => reference.excerpt).filter(Boolean).join(" ")
            : item.laterEvidence;
          paragraph(`Feedback point: ${item.feedbackPoint ?? ""}`);
           paragraph(`Status: ${feedbackStatusLabel(item.status)}`);
          paragraph(`Evidence: ${evidence ?? ""}`);
          paragraph(`Conclusion: ${item.conclusion ?? ""}`);
        }
      }
      if (Array.isArray(response.supportingEvidence) || Array.isArray(response.unresolved) || Array.isArray(response.teacherReview) || Array.isArray(response.evidenceCautions)) {
        heading("Supporting evidence");
        bullets(response.supportingEvidence);
        heading("What remains unresolved");
        bullets(response.unresolved);
        heading("Teacher review");
        bullets(response.teacherReview);
        heading("Evidence cautions");
        bullets(response.evidenceCautions);
      }
    }
    if (phase === "Summative" && input.insight.progressBreakdown) {
      heading("Progress since the Formative Insight");
      for (const [title, items] of [
        ["Addressed", input.insight.progressBreakdown.addressed],
        ["Partly addressed", input.insight.progressBreakdown.partlyAddressed],
        ["Still to develop", input.insight.progressBreakdown.stillToDevelop],
      ] as const) {
        document.font("Helvetica-Bold").fontSize(bodyFontSize).fillColor("#374151").text(title);
        bullets(items?.length ? items : ["Not available from this saved report."]);
      }
    }
    heading(phase === "Formative" && journeyFormat ? "Observed learning and process evidence" : phase === "Summative" ? "Recorded development" : "Strengths");
    bullets(input.insight.strengths);
    heading(phase === "Formative" && journeyFormat ? "Missed opportunities" : phase === "Summative" ? "Opportunities still unused" : "Teacher next steps");
    bullets(input.insight.nextSteps);
    heading(phase === "Formative" && !journeyFormat ? "Cautions" : "Evidence limitations");
    bullets(input.insight.cautions);

    const pages = document.bufferedPageRange();
    for (let index = 0; index < pages.count; index += 1) {
      document.switchToPage(index);
      document.font("Helvetica").fontSize(8).fillColor("#9ca3af")
        .text(`The Assisted Climb · ${phase} Student Insight · Page ${index + 1} of ${pages.count}`, pageMargin, 765, {
          width,
          align: "center",
          lineBreak: false,
          characterSpacing: 0,
          wordSpacing: 0,
        });
    }
    document.end();
  });
}