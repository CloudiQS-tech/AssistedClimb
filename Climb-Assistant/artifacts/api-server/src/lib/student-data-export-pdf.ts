import PDFDocument from "pdfkit";
import { finalAnswerReadableText, isRichTextAnswer } from "./final-answer-format";

type ExportRecord = Record<string, any>;

export type StudentDataExportPayload = ExportRecord & {
  generatedAt: Date | string;
  request: ExportRecord;
  student: ExportRecord & { class?: ExportRecord };
  learning?: { stageEntries?: ExportRecord[] };
  activity?: ExportRecord;
  feedback?: ExportRecord[];
  aiConversations?: ExportRecord[];
  teacherMessages?: ExportRecord[];
  answerFeedbackAttempts?: unknown[];
  answerVersions?: ExportRecord[];
  studentInsights?: ExportRecord;
  developmentAnalysis?: ExportRecord;
  requestHistory?: ExportRecord[];
  developmentSnapshots?: ExportRecord[];
  excluded?: string[];
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const SECURITY_KEYS = new Set([
  "password",
  "passwordHash",
  "pin",
  "pinHash",
  "sessionNonce",
  "apiKey",
  "apiKeyEncrypted",
  "aiKey",
  "aiKeyEncrypted",
  "aiKeySecretRef",
  "aiKeyMasked",
  "aiCredentialEncryptionKey",
  "azureApiKey",
  "geminiApiKey",
  "openaiApiKey",
  "providerCredentials",
  "secretString",
  "secretBinary",
  "secretName",
  "secretId",
  "secretArn",
  "systemPrompt",
  "developerInstructions",
  "internalModeration",
]);

const NORMALISED_SECURITY_KEYS = new Set([
  ...[...SECURITY_KEYS].map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "")),
  "credentials",
  "credential",
  "authorization",
]);

const isSecurityKey = (key: string) =>
  NORMALISED_SECURITY_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));

export function sanitiseStudentDataExportPayload<T extends Record<string, unknown>>(payload: T): T {
  const sanitise = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitise);
    if (value instanceof Date || value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !isSecurityKey(key))
        .map(([key, child]) => [key, sanitise(child)]),
    );
  };
  return sanitise(payload) as T;
}

const displayLabel = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const hasValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasValue);
  return true;
};

const readableValue = (value: unknown): string => {
  if (!hasValue(value)) return "None recorded";
  if (Array.isArray(value)) return value.filter(hasValue).map(readableValue).join("\n");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return "Details recorded below";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

const stageTitles: Record<string, string> = {
  MAP: "MAP — Planning My Enquiry",
  TORCH: "TORCH — Guided AI-Mediated Investigation",
  RESEARCH: "RESEARCH — Sources & Research Notes",
  COMPASS: "COMPASS — Check Your Thinking",
  EMBED: "Final Answer and Reflection",
};

const stageDisplayName = (stage: unknown): string => {
  if (typeof stage !== "string") return "Unknown section";
  const normalised = stage.toUpperCase();
  if (normalised === "OVERALL") return "Overall assessment";
  return stageTitles[normalised] ?? stage;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");

type RichTextRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  heading?: boolean;
};

const richTextRuns = (value: string): RichTextRun[] => {
  const clean = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?!\/?(?:p|h1|h2|ol|ul|li|strong|em|u|br)(?:\s|>|\/))[^>]*>/gi, "");
  const tokens = clean.split(/(<\/?(?:p|h1|h2|ol|ul|li|strong|em|u|br)(?:\s[^>]*)?>)/gi);
  const runs: RichTextRun[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let heading = false;
  let ordered = false;
  let orderedIndex = 0;
  const append = (text: string, overrides: Partial<RichTextRun> = {}) => {
    if (!text) return;
    runs.push({ text: decodeHtmlEntities(text), bold, italic, underline, heading, ...overrides });
  };

  tokens.forEach((token) => {
    if (!token.startsWith("<")) {
      append(token);
      return;
    }
    const tag = token.toLowerCase();
    if (/^<h[12](?:\s[^>]*)?>/.test(tag)) {
      append("\n");
      heading = true;
    } else if (/^<\/h[12]>/.test(tag)) {
      append("\n");
      heading = false;
    } else if (/^<p(?:\s[^>]*)?>/.test(tag)) {
      append("\n");
    } else if (/^<\/p>/.test(tag)) {
      append("\n");
    } else if (/^<br/.test(tag)) {
      append("\n");
    } else if (/^<ol>/.test(tag)) {
      ordered = true;
      orderedIndex = 0;
      append("\n");
    } else if (/^<\/ol>/.test(tag)) {
      ordered = false;
      append("\n");
    } else if (/^<ul>/.test(tag)) {
      ordered = false;
      append("\n");
    } else if (/^<\/ul>/.test(tag)) {
      append("\n");
    } else if (/^<li\b/.test(tag)) {
      orderedIndex += ordered ? 1 : 0;
      append(`\n${ordered ? `${orderedIndex}. ` : "• "}`);
    } else if (/^<strong>/.test(tag)) {
      bold = true;
    } else if (/^<\/strong>/.test(tag)) {
      bold = false;
    } else if (/^<em>/.test(tag)) {
      italic = true;
    } else if (/^<\/em>/.test(tag)) {
      italic = false;
    } else if (/^<u>/.test(tag)) {
      underline = true;
    } else if (/^<\/u>/.test(tag)) {
      underline = false;
    }
  });
  return runs;
};

const createPdfBuffer = (payload: StudentDataExportPayload): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, right: MARGIN, bottom: 58, left: MARGIN },
      bufferPages: true,
      info: {
        Title: `Readable student record — ${payload.student?.name ?? "Student"}`,
        Subject: "School-scoped student data access record",
        Author: "The Assisted Climb",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    const ensureSpace = (height = 48) => {
      if (document.y > PAGE_HEIGHT - 58 - height) document.addPage();
    };

    const title = (text: string) => {
      ensureSpace(44);
      document.font("Helvetica-Bold").fontSize(18).fillColor("#111827").text(text);
      document.moveDown(0.25);
    };

    const section = (text: string) => {
      ensureSpace(56);
      document.moveDown(0.7);
      document.font("Helvetica-Bold").fontSize(15).fillColor("#075985").text(text);
      document.moveTo(MARGIN, document.y + 5).lineTo(PAGE_WIDTH - MARGIN, document.y + 5).strokeColor("#bae6fd").stroke();
      document.moveDown(0.6);
    };

    const subheading = (text: string) => {
      ensureSpace(32);
      document.moveDown(0.35);
      document.font("Helvetica-Bold").fontSize(11).fillColor("#1f2937").text(text);
      document.moveDown(0.15);
    };

    const paragraph = (text: string, options: { color?: string; italic?: boolean } = {}) => {
      ensureSpace(25);
      document.font(options.italic ? "Helvetica-Oblique" : "Helvetica")
        .fontSize(9.5)
        .fillColor(options.color ?? "#374151")
        .text(text, { width: CONTENT_WIDTH, lineGap: 2 });
      document.moveDown(0.15);
    };

    const richText = (label: string, value: unknown) => {
      if (typeof value !== "string" || !value.trim()) {
        field(label, value);
        return;
      }
      subheading(label);
      if (!isRichTextAnswer(value)) {
        paragraph(finalAnswerReadableText(value));
        return;
      }
      const runs = richTextRuns(value);
      if (runs.length === 0) {
        paragraph("No response recorded.", { color: "#6b7280", italic: true });
        return;
      }
      runs.forEach((run, index) => {
        ensureSpace(25);
        const font = run.bold && run.italic
          ? "Helvetica-BoldOblique"
          : run.bold
            ? "Helvetica-Bold"
            : run.italic
              ? "Helvetica-Oblique"
              : "Helvetica";
        document.font(font)
          .fontSize(run.heading ? 12 : 10)
          .fillColor("#111827")
          .text(run.text, {
            width: CONTENT_WIDTH,
            lineGap: 2,
            continued: index < runs.length - 1,
            underline: run.underline,
          });
      });
      document.moveDown(0.3);
    };

    const field = (label: string, value: unknown, options: { link?: string } = {}) => {
      ensureSpace(31);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#6b7280").text(label.toUpperCase(), { characterSpacing: 0.4 });
      document.font("Helvetica").fontSize(10).fillColor("#111827");
      const text = readableValue(value);
      document.text(text, options.link ? { link: options.link, underline: true, width: CONTENT_WIDTH, lineGap: 2 } : { width: CONTENT_WIDTH, lineGap: 2 });
      document.moveDown(0.3);
    };

    const list = (label: string, values: unknown) => {
      const items = Array.isArray(values) ? values.filter(hasValue) : hasValue(values) ? [values] : [];
      if (items.length === 0) {
        field(label, null);
        return;
      }
      ensureSpace(28);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#6b7280").text(label.toUpperCase(), { characterSpacing: 0.4 });
      items.forEach((item) => {
        ensureSpace(22);
        document.font("Helvetica").fontSize(10).fillColor("#111827").text(`• ${readableValue(item)}`, { width: CONTENT_WIDTH - 10, indent: 10, lineGap: 2 });
      });
      document.moveDown(0.3);
    };

    const nested = (label: string, value: unknown, depth = 0) => {
      if (!hasValue(value)) return;
      if (Array.isArray(value)) {
        value.filter(hasValue).forEach((item, index) => nested(`${label} ${index + 1}`, item, depth + 1));
        return;
      }
      if (typeof value !== "object") {
        field(label, value);
        return;
      }
      subheading(label);
      Object.entries(value as ExportRecord).forEach(([key, child]) => {
        if (!isSecurityKey(key) && hasValue(child)) nested(displayLabel(key), child, depth + 1);
      });
    };

    const additional = (record: ExportRecord, consumed: string[], heading = "Additional saved content") => {
      const consumedKeys = new Set(consumed);
      const entries = Object.entries(record).filter(([key, value]) =>
        !consumedKeys.has(key) && !isSecurityKey(key) && key !== "id" && hasValue(value),
      );
      if (entries.length === 0) return;
      subheading(heading);
      entries.forEach(([key, value]) => nested(displayLabel(key), value));
    };

    const structured = (label: string, value: unknown, depth = 0): void => {
      if (!hasValue(value)) {
        field(label, null);
        return;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          field(label, null);
          return;
        }
        subheading(label);
        value.forEach((item, index) => structured(`${label} ${index + 1}`, item, depth + 1));
        return;
      }
      if (typeof value === "object") {
        subheading(label);
        Object.entries(value as ExportRecord).forEach(([key, child]) => {
          if (!isSecurityKey(key)) structured(displayLabel(key), child, depth + 1);
        });
        return;
      }
      field(label, value);
    };

    const structuredList = (label: string, value: unknown) => {
      if (!Array.isArray(value)) {
        list(label, value);
        return;
      }
      if (value.length === 0) {
        field(label, null);
        return;
      }
      subheading(label);
      value.forEach((item, index) => structured(`${label} ${index + 1}`, item));
    };

    const feedback = (entry: ExportRecord | undefined) => {
      if (!entry) return;
      subheading("Teacher feedback");
      field("Formative feedback", entry.formativeComment);
      field("Summative grade", entry.grade);
      field("Summative feedback", entry.comment);
      field("Student acknowledged", entry.studentAcknowledged);
      field("Feedback date", entry.updatedAt);
      additional(entry, ["stage", "grade", "formativeComment", "comment", "studentAcknowledged", "updatedAt"], "Additional feedback details");
    };

    const mapStage = (content: ExportRecord) => {
      const modernFields: Array<[string, unknown]> = [
        ["Understanding of the task", content.taskUnderstanding],
        ["What I already know", content.priorKnowledge],
        ["What I need to find out", content.knowledgeGaps],
        ["Enquiry questions", content.enquiryQuestions],
      ];
      const legacyFields: Array<[string, unknown]> = [
        ["What is this task asking you to do?", content.q1],
        ["What do you already know about this topic?", content.q2],
        ["What might be difficult about this task?", content.q3],
        ["Break the task into its component parts.", content.q4],
        ["Plan your research.", content.q5],
      ];
      const fields = ["taskUnderstanding", "priorKnowledge", "knowledgeGaps", "enquiryQuestions", "researchPlan"].some((key) => key in content)
        ? modernFields
        : legacyFields;
      fields.forEach(([label, value]) => Array.isArray(value) ? list(label, value) : field(label, value));
      const plan = Array.isArray(content.researchPlan) ? content.researchPlan.filter(hasValue) : [];
      if (plan.length) {
        subheading("MAP item 5 — Research Plan");
        plan.forEach((row: ExportRecord, index) => {
          subheading(`Plan item ${index + 1}`);
          field("Planned investigation", row.investigation);
          list("Planned source types", row.sources ?? row.sourceTypes);
          field("Planned source or link", row.plannedSource);
          list("Planned verification strategies", row.verificationSelections);
          field("Verification notes", row.verification);
          additional(row, ["id", "investigation", "sources", "sourceTypes", "plannedSource", "verificationSelections", "verification"], "Additional plan details");
        });
      }
      field("Planning notes", content.notes);
      additional(content, ["taskUnderstanding", "priorKnowledge", "knowledgeGaps", "enquiryQuestions", "researchPlan", "notes", "q1", "q2", "q3", "q4", "q5"], "Additional MAP content");
    };

    const torchStage = (messages: ExportRecord[]) => {
      if (!messages.length) {
        paragraph("No TORCH conversation recorded.", { color: "#6b7280", italic: true });
        return;
      }
      messages.forEach((message, index) => {
        const role = message.role === "user" ? "Student" : message.role === "assistant" ? "AI" : "Conversation message";
        subheading(`${role} message ${index + 1}`);
        field("Date and time", message.createdAt);
        field("Message", message.content);
        field("Bloom level", message.bloomLevel);
      });
    };

    const researchStage = (content: ExportRecord) => {
      const entries = Array.isArray(content.entries) ? content.entries.filter(hasValue) : [];
      if (!entries.length) {
        paragraph("No Research Log source recorded.", { color: "#6b7280", italic: true });
        return;
      }
      entries.forEach((source: ExportRecord, index) => {
        subheading(`Research source ${index + 1}`);
        const sourceText = source.actualSource ?? source.source ?? source.title ?? source.url;
        field("Source origin", source.sourceOrigin ?? source.sourceProvenance?.type);
        field("Source type", source.sourceType);
        field("Actual source used", sourceText, { link: typeof sourceText === "string" && /^https?:\/\//.test(sourceText) ? sourceText : undefined });
        field("Link or citation", source.sourceDetails ?? source.citation ?? source.url, { link: typeof source.url === "string" ? source.url : undefined });
        if (source.mapContext) {
          subheading("Original Research Plan connection");
          field("Planned investigation", source.mapContext.investigation);
          list("Planned source types", source.mapContext.sourceTypes);
          field("Planned source or link", source.mapContext.plannedSource);
          list("Planned verification strategies", source.mapContext.verificationSelections);
          field("Verification notes", source.mapContext.verification);
        }
        field("What the student learned", source.findings ?? source.combinedLearning);
        field("What the student considered most important", source.importantPoints);
        list("Trustworthiness checks", source.trustworthinessSelections);
        field("Trustworthiness explanation", source.reliability);
        field("How the source affected the student’s thinking", source.usage);
        field("Effect selection", source.effectSelection);
        field("Timestamp", source.addedAt);
        field("Completion status", source.isComplete ? "Complete" : "In progress");
        additional(source, ["sourceOrigin", "sourceType", "actualSource", "source", "title", "url", "sourceDetails", "citation", "sourceProvenance", "findings", "combinedLearning", "importantPoints", "trustworthinessSelections", "reliability", "usage", "effectSelection", "addedAt", "isComplete", "mapContext"], "Additional source content");
      });
      additional(content, ["entries"], "Additional Research Log content");
    };

    const compassStage = (content: ExportRecord) => {
      [
        ["Say it in your own words", content.check1],
        ["The strongest challenge to your thinking", content.check2],
        ["Where you are least confident", content.check3],
        ["Is your evidence balanced?", content.check4],
        ["Are you ready to write?", content.check5],
        ["Self-learning reflection 1", content.sl1],
        ["Self-learning reflection 2", content.sl2],
        ["Self-learning reflection 3", content.sl3],
        ["Self-learning reflection 4", content.sl4],
        ["Self-learning reflection 5", content.sl5],
      ].forEach(([label, value]) => field(label as string, value));
      additional(content, ["check1", "check2", "check3", "check4", "check5", "sl1", "sl2", "sl3", "sl4", "sl5"], "Additional COMPASS content");
    };

    const embedStage = (content: ExportRecord) => {
      richText("Final answer or submission", content.finalAnswer);
      structured("Existing supporting materials note", content.supportingMaterials);
      if (Array.isArray(content.supportingMaterialCards)) {
        content.supportingMaterialCards.forEach((card: ExportRecord, index: number) => {
          subheading(`Supporting material ${index + 1}`);
          structured("Name of the material", card.name);
          structured("Type of material", card.type);
          structured("What does it show?", card.whatItShows);
          structured("Why is it relevant to the answer?", card.whyRelevant);
          structured("Where is it referred to in the Final Answer?", card.finalResponseReference);
          structured("How was it shared with the teacher?", card.sharingMethod);
        });
      }
      [
        ["What changed in your understanding?", content.q1],
        ["Where did you do the thinking?", content.q2],
        ["How did AI help your learning?", content.q3],
        ["What did you decide not to trust?", content.q4],
      ].forEach(([label, value]) => field(label as string, value));
      additional(content, ["finalAnswer", "supportingMaterials", "supportingMaterialCards", "q1", "q2", "q3", "q4"], "Additional final-response content");
    };

    const answerFeedback = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        paragraph("No answer feedback recorded.", { color: "#6b7280", italic: true });
        return;
      }
      const feedbackRecord = value as ExportRecord;
      const requirements = feedbackRecord.requirementCoverage as ExportRecord | undefined;
      if (requirements && typeof requirements === "object" && !Array.isArray(requirements)) {
        subheading("Requirement coverage");
        const taskQuestion = requirements.taskQuestion as ExportRecord | undefined;
        if (taskQuestion && typeof taskQuestion === "object") {
          field("Task question status", taskQuestion.status);
          field("Task question feedback", taskQuestion.feedback);
        }
        structuredList("Success criteria", requirements.successCriteria);
      }
      structuredList("Key vocabulary", feedbackRecord.keyVocabulary);
      const length = feedbackRecord.expectedLengthOrFormat as ExportRecord | undefined;
      if (length && typeof length === "object") {
        subheading("Expected length or format");
        field("Requirement", length.requirement);
        field("Status", length.status);
        field("Feedback", length.feedback);
      }
      const stageEvidence = feedbackRecord.stageEvidence as ExportRecord | undefined;
      if (stageEvidence && typeof stageEvidence === "object") {
        subheading("Stage evidence");
        Object.entries(stageEvidence).forEach(([stage, evidence]) => {
          const row = evidence as ExportRecord;
          subheading(stageDisplayName(stage));
          field("Used", row?.used);
          field("Feedback", row?.feedback);
        });
      }
      list("Strengths", feedbackRecord.strengths);
      list("Areas for development", feedbackRecord.areasForDevelopment);
      list("Next steps", feedbackRecord.nextSteps);
      additional(feedbackRecord, [
        "requirementCoverage",
        "keyVocabulary",
        "expectedLengthOrFormat",
        "stageEvidence",
        "strengths",
        "areasForDevelopment",
        "nextSteps",
      ], "Additional answer feedback");
    };

    const renderAnswerVersions = () => {
      const versions = payload.answerVersions ?? [];
      if (versions.length === 0) {
        paragraph("No retained answer versions recorded.", { color: "#6b7280", italic: true });
        return;
      }
      versions.forEach((version, index) => {
        subheading(version.label ?? `Final answer version ${index + 1}`);
        field("Recorded", version.createdAt);
        richText("Answer", version.answer);
        if (version.feedback) {
          answerFeedback(version.feedback);
        }
      });
    };

    const renderInsights = () => {
      const insights = payload.studentInsights ?? {};
      (["formative", "summative"] as const).forEach((phase) => {
        const insight = insights[phase];
        subheading(phase === "formative" ? "Formative Student Insight" : "Summative Student Insight");
        if (!insight || typeof insight !== "object" || Array.isArray(insight)) {
          paragraph("None recorded.", { color: "#6b7280", italic: true });
          return;
        }
        structured("Insight", insight);
      });
    };

    const renderDevelopmentAnalysis = () => {
      const analysis = payload.developmentAnalysis ?? {};
      if (analysis.status === "failed") {
        field("Status", "Unavailable or unsuccessful");
        field("Date", analysis.generatedAt);
        return;
      }
      if (analysis.report && typeof analysis.report === "object") {
        structured("Development analysis", analysis.report);
        field("Generated", analysis.generatedAt);
        return;
      }
      paragraph("No successful student-specific development analysis recorded.", { color: "#6b7280", italic: true });
    };

    const entriesByStage = Object.fromEntries(
      (payload.learning?.stageEntries ?? []).filter((entry) => entry && typeof entry.stage === "string").map((entry) => [entry.stage, entry]),
    ) as Record<string, ExportRecord>;
    const feedbackByStage = Object.fromEntries(
      (payload.feedback ?? []).filter((entry) => entry && typeof entry.stage === "string").map((entry) => [entry.stage, entry]),
    ) as Record<string, ExportRecord>;

    document.font("Helvetica-Bold").fontSize(25).fillColor("#075985").text("Readable student record");
    document.moveDown(0.45);
    paragraph("A school-scoped copy of the student information included in this authorised access request.", { color: "#4b5563" });
    field("Generated", payload.generatedAt);
    field("Data-request reference", payload.request?.id);
    field("Record period", payload.periodCovered);
    document.addPage();

    section("Student and request information");
    field("Student name", payload.student?.name);
    field("Class", payload.student?.class?.name);
    field("Subject", payload.student?.class?.subject);
    field("School", payload.school?.name);
    field("Request type", payload.request?.requestType);
    field("Request status", payload.request?.status);
    field("Student record created", payload.student?.createdAt);
    field("Registration status", payload.student?.registrationStatus);
    field("Assessment status", payload.student?.lockedAt ? "Locked" : "Open");
    field("Archived at", payload.student?.archivedAt);
    field("Retention until", payload.student?.retentionUntil);

    section("Climb and task information");
    field("Climb or class name", payload.student?.class?.name);
    field("Teacher", payload.teacher?.name);
    field("Task title", payload.task?.title);
    field("Subject", payload.task?.subject ?? payload.student?.class?.subject);
    field("Task question", payload.task?.question);
    field("Task instructions", payload.task?.instructions);
    list("Success criteria", payload.task?.successCriteria);
    list("Key vocabulary", payload.task?.keyVocabulary);
    field("Expected length", payload.task?.expectedLength);
    list("Enabled Climb sections", (payload.task?.enabledStages ?? []).map(stageDisplayName));
    field("Formative assessment date", payload.task?.formativeAssessmentDate);
    field("Summative assessment date", payload.task?.summativeAssessmentDate);
    list("Teacher-provided resources", payload.task?.resources);
    if (payload.task?.stageInstructions && typeof payload.task.stageInstructions === "object") {
      subheading("Stage instructions");
      Object.entries(payload.task.stageInstructions).forEach(([stage, instruction]) =>
        field(stageDisplayName(stage), instruction),
      );
    }
    field("Assignment date", payload.task?.assignmentDate);
    field("Final deadline", payload.task?.deadline);
    field("Completion status", payload.task?.completionStatus);

    section("Student climb record");
    for (const stage of ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"]) {
      subheading(stageTitles[stage]);
      const entry = entriesByStage[stage];
      if (stage === "TORCH") torchStage(payload.aiConversations ?? []);
      else if (!entry) paragraph("No response recorded.", { color: "#6b7280", italic: true });
      else if (stage === "MAP") mapStage(entry.contentJson ?? {});
      else if (stage === "RESEARCH") researchStage(entry.contentJson ?? {});
      else if (stage === "COMPASS") compassStage(entry.contentJson ?? {});
       else if (stage === "EMBED") embedStage(entry.contentJson ?? {});
      field("Stage updated", entry?.updatedAt);
      feedback(feedbackByStage[stage]);
    }

    section("Overall teacher feedback and assessment");
    feedback(feedbackByStage.OVERALL);
    if (!feedbackByStage.OVERALL) paragraph("No overall feedback recorded.", { color: "#6b7280", italic: true });
    field("Assessment locked", payload.student?.lockedAt);
    field("Final-answer feedback attempts", (payload.answerFeedbackAttempts ?? []).length ? `${payload.answerFeedbackAttempts?.length} attempt(s) recorded` : null);
     (payload.answerFeedbackAttempts ?? []).forEach((attempt, index) => {
       subheading(`AI feedback attempt ${index + 1}`);
       field("Created", (attempt as ExportRecord).createdAt);
       richText("Answer snapshot", (attempt as ExportRecord).answerSnapshot);
       answerFeedback((attempt as ExportRecord).feedback);
     });
     section("Retained final answer versions");
     renderAnswerVersions();

     section("Student Insights");
     renderInsights();

     section("Development analysis");
     renderDevelopmentAnalysis();

    section("Teacher messages");
    if ((payload.teacherMessages ?? []).length === 0) {
      paragraph("No teacher messages recorded.", { color: "#6b7280", italic: true });
    } else {
      (payload.teacherMessages ?? []).forEach((message, index) => {
        subheading(`Message ${index + 1}`);
        field("Sent", message.createdAt);
        field("Sender", message.senderType);
        field("Message", message.content);
        field("Teacher read at", message.teacherReadAt);
        field("Student read at", message.studentReadAt);
      });
    }

    if ((payload.developmentSnapshots ?? []).length > 0) {
      section("Preserved development snapshots");
       (payload.developmentSnapshots ?? []).forEach((snapshot, index) => {
        subheading(`Snapshot ${index + 1}`);
         field("Snapshot", snapshot.snapshotKind === "answer_assessment_finalisation"
           ? "Final answer at assessment finalisation"
           : snapshot.snapshotKind === "climb_formative"
             ? "Formative Climb snapshot"
             : snapshot.snapshotKind === "climb_summative"
               ? "Summative Climb snapshot"
               : snapshot.snapshotKind);
        field("Trigger event", snapshot.triggerEvent);
        field("Created", snapshot.createdAt);
         if (snapshot.snapshotKind === "answer_assessment_finalisation") {
           richText("Final answer at this point", (snapshot.payload as ExportRecord)?.finalAnswer);
         } else {
           const snapshotPayload = snapshot.payload as ExportRecord | undefined;
           field("Preserved stage records", Array.isArray(snapshotPayload?.stageEntries) ? snapshotPayload.stageEntries.length : null);
           field("Preserved conversation messages", Array.isArray(snapshotPayload?.chatMessages) ? snapshotPayload.chatMessages.length : null);
           field("Preserved feedback records", Array.isArray(snapshotPayload?.feedback) ? snapshotPayload.feedback.length : null);
           paragraph("Historical stage, conversation, and feedback data is represented in the sections above; this entry preserves the earlier assessment point without duplicating that content.", { color: "#6b7280", italic: true });
         }
      });
    }

    section("Relevant activity information");
    const activity = payload.activity ?? {};
    field("Recorded activity periods", activity.summary?.totalSessions);
    field("Login sessions", activity.summary?.loginSessionsAvailable ? activity.summary?.loginSessionCount : "Not available");
    field("Total recorded activity", activity.summary?.totalSeconds ? `${activity.summary.totalSeconds} seconds` : null);
    field("Average login session", activity.summary?.loginSessionsAvailable ? `${activity.summary?.averageLoginSessionSeconds ?? 0} seconds` : "Not available");
    field("Longest login session", activity.summary?.loginSessionsAvailable ? `${activity.summary?.longestLoginSessionSeconds ?? 0} seconds` : "Not available");
     field("Active stages recorded", (activity.summary?.pageDurations ?? []).map((page: ExportRecord) => `${stageDisplayName(page.stage)}: ${page.durationSeconds} seconds`));
    (activity.entries ?? []).forEach((entry: ExportRecord, index: number) => {
      subheading(`Activity period ${index + 1}`);
      field("Started", entry.startedAt);
      field("Last seen", entry.lastSeenAt);
      field("Ended", entry.endedAt);
       field("Active stage", stageDisplayName(entry.activeStage));
      field("Duration", entry.durationSeconds ? `${entry.durationSeconds} seconds` : null);
       field("End reason", entry.endReason);
       field("Stage timings", (entry.pageDurations ?? []).map((page: ExportRecord) => `${stageDisplayName(page.stage)}: ${page.durationSeconds} seconds`));
    });

     section("Student-data request history");
     field("Request reason", payload.request?.reason);
     field("Approval basis", payload.request?.approvalBasis);
     if ((payload.requestHistory ?? []).length === 0) {
       paragraph("No request history recorded.", { color: "#6b7280", italic: true });
     } else {
       (payload.requestHistory ?? []).forEach((event, index) => {
         subheading(`Request event ${index + 1}`);
         field("Event", event.action);
         field("Date", event.createdAt);
         field("Export type", event.exportType);
         field("Status", event.status);
         field("Outcome", event.outcome);
       });
     }

    section("Data boundaries");
    paragraph("This record is limited to the selected student, the authorised school request, and the permissions of the School Master who requested it.");
    list("Not included", payload.excluded);

    const pageRange = document.bufferedPageRange();
    for (let index = 0; index < pageRange.count; index += 1) {
      document.switchToPage(index);
      document.font("Helvetica").fontSize(8).fillColor("#6b7280")
        .text(`The Assisted Climb · Student record · Page ${index + 1} of ${pageRange.count}`, MARGIN, PAGE_HEIGHT - 70, {
          width: CONTENT_WIDTH,
          align: "center",
          lineBreak: false,
        });
    }
    document.end();
  });

export const renderStudentDataExportPdf = (payload: StudentDataExportPayload) => createPdfBuffer(payload);