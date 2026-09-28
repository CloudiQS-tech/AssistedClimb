import { createHash } from "crypto";
import { minimiseAiText } from "./ai";
import { finalAnswerReadableText, isRichTextAnswer } from "./final-answer-format";

export const DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH = 7_000;

export type DevelopmentEvidenceSummary = {
  formativeClimbPresent: boolean;
  summativeClimbPresent: boolean;
  changedStageCount: number;
  sourceChangeCount: number;
  torchChangeCount: number;
  formativeFeedbackCount: number;
  answerOneCharacters: number;
  aiFeedbackOnePresent: boolean;
  answerTwoCharacters: number;
  aiFeedbackTwoPresent: boolean;
  finalAnswerCharacters: number;
  answerComparisonCount: number;
  truncated: boolean;
};

type Snapshot = {
  snapshotKind: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
};

type AnswerFeedbackAttempt = {
  answerSnapshot: string;
  feedback: unknown;
  createdAt: string;
};

type ActivitySession = {
  loginSessionId?: string | null;
  startedAt: Date | string;
  lastSeenAt: Date | string;
  endedAt: Date | string | null;
  activeStage: string | null;
  pageDurations?: unknown;
};

export type StudentInsightActivityComparison = {
  formativeGeneratedAt: string | null;
  atFormative: {
    recordedSessions: number | null;
    recordedSeconds: number | null;
    torchQuestions: number | null;
    torchResponses: number | null;
  };
  sinceFormative: {
    recordedSessions: number | null;
    recordedSeconds: number | null;
    torchQuestions: number | null;
    torchResponses: number | null;
  };
  summativeTotal: {
    recordedSessions: number | null;
    recordedSeconds: number | null;
    torchQuestions: number | null;
    torchResponses: number | null;
  };
  finalAnswerFeedbackRoundsUsed: number | null;
  changedStages: string[];
};

const stages = ["MAP", "TORCH", "RESEARCH", "COMPASS", "EMBED"] as const;
const stageLabels: Record<(typeof stages)[number], string> = {
  MAP: "MAP — Plan and frame",
  TORCH: "TORCH — Investigate with AI",
  RESEARCH: "RESEARCH — Check sources",
  COMPASS: "COMPASS — Check your thinking",
  EMBED: "ANSWER — Write the response",
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function textWords(value: unknown): string[] {
  return typeof value === "string"
    ? value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    : [];
}

function boundedText(value: unknown, maximumLength = 3_000): string {
  return typeof value === "string"
    ? minimiseAiText(value.replace(/\s+/g, " ").trim(), maximumLength)
    : "";
}

function snapshotDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "unavailable" : date.toISOString();
}

function contentText(value: unknown): string {
  if (typeof value === "string") return boundedText(value);
  if (!value || typeof value !== "object") return "";
  return boundedText(JSON.stringify(sanitiseEvidenceValue(value)), 4_000);
}

const IDENTITY_KEY = /(?:^|_)(?:id|name|email|phone|student|teacher|class|session)(?:$|_)/i;

/** Apply the same identity minimisation to every provider-bound text value. */
function sanitiseEvidenceValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[omitted: nesting limit]";
  if (typeof value === "string") return boundedText(isRichTextAnswer(value) ? finalAnswerReadableText(value) : value, 1_200);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitiseEvidenceValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["supportingMaterials", "supportingMaterialCards"].includes(key) && !IDENTITY_KEY.test(key.replace(/[A-Z]/g, (letter) => `_${letter}`).toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, sanitiseEvidenceValue(child, depth + 1)]));
}

function feedbackSummary(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const result = {
      stage: boundedText(row.stage, 80),
      comment: boundedText(row.comment, 2_000),
      formativeComment: boundedText(row.formativeComment, 2_000),
    };
    return result.stage || result.comment || result.formativeComment ? [result] : [];
  });
}

function fitEvidenceBudget(value: Record<string, unknown>): Record<string, unknown> {
  const originalChars = JSON.stringify(value).length;
  const levels = [
    { stringLength: 700, arrayLength: 8 },
    { stringLength: 420, arrayLength: 6 },
    { stringLength: 260, arrayLength: 4 },
    { stringLength: 140, arrayLength: 3 },
    { stringLength: 72, arrayLength: 2 },
    { stringLength: 32, arrayLength: 1 },
  ];
  for (const level of levels) {
    const truncatedFields: string[] = [];
    const omittedFields: string[] = [];
    const shrink = (current: unknown, path: string): unknown => {
      if (typeof current === "string") {
        if (current.length <= level.stringLength) return current;
        truncatedFields.push(path);
        return `${current.slice(0, Math.max(0, level.stringLength - 18))} [truncated]`;
      }
      if (Array.isArray(current)) {
        if (current.length > level.arrayLength) omittedFields.push(path);
        return current.slice(0, level.arrayLength).map((item, index) => shrink(item, `${path}[${index}]`));
      }
      if (current && typeof current === "object") {
        return Object.fromEntries(Object.entries(current).map(([key, child]) => [
          key,
          shrink(child, path ? `${path}.${key}` : key),
        ]));
      }
      return current;
    };
    const compact = shrink(value, "") as Record<string, unknown>;
    compact.truncation = {
      budgetChars: DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH,
      originalChars,
      identityMinimised: true,
      truncated: truncatedFields.length > 0,
      truncatedFields: truncatedFields.slice(0, 40),
      omittedFields: omittedFields.slice(0, 40),
    };
    let serialised = JSON.stringify(compact);
    for (let attempt = 0; attempt < 3; attempt++) {
      compact.truncation = {
        ...(compact.truncation as Record<string, unknown>),
        finalChars: serialised.length,
      };
      const next = JSON.stringify(compact);
      if (next.length === serialised.length) break;
      serialised = next;
    }
    serialised = JSON.stringify(compact);
    if (serialised.length <= DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH) return compact;
  }

  const excerpt = (candidate: unknown, maximumLength = 160): string => {
    const text = typeof candidate === "string"
      ? candidate.replace(/\s+/g, " ").trim()
      : candidate === null || candidate === undefined
        ? ""
        : JSON.stringify(candidate).replace(/\s+/g, " ").trim();
    if (text.length <= maximumLength) return text;
    const candidateText = text.slice(0, Math.max(1, maximumLength - 1));
    const sentenceEnd = Math.max(
      candidateText.lastIndexOf(". "),
      candidateText.lastIndexOf("! "),
      candidateText.lastIndexOf("? "),
    );
    const wordEnd = candidateText.lastIndexOf(" ");
    const boundary = sentenceEnd >= Math.floor(maximumLength * 0.55)
      ? sentenceEnd + 1
      : wordEnd;
    return `${candidateText.slice(0, Math.max(1, boundary)).trim()}…`;
  };
  const record = (candidate: unknown): Record<string, unknown> =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
  const source = record(value.climb);
  const changedStages = Array.isArray(source.changedStages) ? source.changedStages : [];
  const feedback = record(value.feedback);
  const feedbackExcerpt = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.slice(0, 3).map((item) => {
      const row = record(item);
      return {
        stage: excerpt(row.stage, 50),
        comment: excerpt(row.comment, 100),
        formativeComment: excerpt(row.formativeComment, 100),
      };
    }).filter((item) => item.stage || item.comment || item.formativeComment)
    : [];
  const answerEvidence = record(value.answers);
  const comparisonExcerpt = Array.isArray(answerEvidence.comparisons)
    ? answerEvidence.comparisons.slice(0, 3).map((item) => {
      const row = record(item);
      const comparison = record(row.overlap);
      return {
        from: excerpt(row.from, 30),
        to: excerpt(row.to, 30),
        firstWordCount: row.firstWordCount,
        secondWordCount: row.secondWordCount,
        changed: row.changed,
        overlap: {
          exact: comparison.exact,
          sharedWordCount: comparison.sharedWordCount,
          jaccard: comparison.jaccard,
          nearOverlap: comparison.nearOverlap,
        },
      };
    })
    : [];
  // The compact fallback keeps both evidence priorities and meaningful
  // excerpts present even for pathological input. It is intentionally
  // assembled from the already identity-minimised raw package.
  const compact = {
    omissionNotice: "Provider budget reached. Excerpts below are bounded; omitted bulk remains in preserved snapshots for teacher review.",
    snapshotTimestamps: Array.isArray(value.snapshotTimestamps) ? value.snapshotTimestamps.slice(0, 3) : [],
    timeline: Array.isArray(value.timeline) ? value.timeline.slice(0, 8) : [],
    elapsedSeconds: value.elapsedSeconds ?? null,
    climb: {
      changedStages: changedStages.slice(0, 5).map((item) => {
        const row = record(item);
        return {
          stage: excerpt(row.stage, 40),
          before: excerpt(row.before, 160),
          after: excerpt(row.after, 160),
          beforeWordCount: row.beforeWordCount,
          afterWordCount: row.afterWordCount,
          addedWordCount: row.addedWordCount,
          removedWordCount: row.removedWordCount,
          overlap: record(row.overlap),
        };
      }),
      sourceChanges: {
        added: Array.isArray(record(source.sourceChanges).added)
          ? (record(source.sourceChanges).added as unknown[]).slice(0, 2).map((item) => excerpt(item, 140))
          : [],
        removed: Array.isArray(record(source.sourceChanges).removed)
          ? (record(source.sourceChanges).removed as unknown[]).slice(0, 2).map((item) => excerpt(item, 140))
          : [],
        edited: Array.isArray(record(source.sourceChanges).edited)
          ? (record(source.sourceChanges).edited as unknown[]).slice(0, 2).map((item) => excerpt(item, 140))
          : [],
      },
      torchChanges: {
        added: Array.isArray(record(source.torchChanges).added)
          ? (record(source.torchChanges).added as unknown[]).slice(0, 5).map((item) => excerpt(item))
          : [],
        removed: Array.isArray(record(source.torchChanges).removed)
          ? (record(source.torchChanges).removed as unknown[]).slice(0, 5).map((item) => excerpt(item))
          : [],
        studentMessageCount: record(source.torchChanges).studentMessageCount ?? 0,
        aiResponseCount: record(source.torchChanges).aiResponseCount ?? 0,
        addedStudentMessages: Array.isArray(record(source.torchChanges).addedStudentMessages)
          ? (record(source.torchChanges).addedStudentMessages as unknown[]).slice(0, 5).map((item) => excerpt(item))
          : [],
        addedAiResponses: Array.isArray(record(source.torchChanges).addedAiResponses)
          ? (record(source.torchChanges).addedAiResponses as unknown[]).slice(0, 5).map((item) => excerpt(item))
          : [],
        timing: record(source.torchChanges).timing ?? "unavailable",
      },
    },
    feedback: {
      formative: feedbackExcerpt(feedback.formative),
      summative: feedbackExcerpt(feedback.summative),
      answer1: excerpt(feedback.answer1),
      answer2: excerpt(feedback.answer2),
    },
    answers: {
      answer1: excerpt(answerEvidence.answer1, 240),
      aiFeedback1: excerpt(answerEvidence.aiFeedback1, 120),
      answer2: excerpt(answerEvidence.answer2, 240),
      aiFeedback2: excerpt(answerEvidence.aiFeedback2, 120),
      finalAnswer: excerpt(answerEvidence.finalAnswer, 240),
      comparisons: comparisonExcerpt,
      cumulativeComparison: (() => {
        const row = record(answerEvidence.cumulativeComparison);
        return {
          from: excerpt(row.from, 30),
          to: excerpt(row.to, 30),
          firstWordCount: row.firstWordCount,
          secondWordCount: row.secondWordCount,
          changed: row.changed,
          overlap: record(row.overlap),
        };
      })(),
    },
    truncation: {
      budgetChars: DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH,
      originalChars,
      identityMinimised: true,
      truncated: true,
      fallbackUsed: true,
      truncatedFields: ["text excerpts"],
      omittedFields: ["unchanged bulk", "full stage payloads", "unbounded feedback"],
    },
  };
  let compactSerialised = JSON.stringify(compact);
  for (let attempt = 0; attempt < 3; attempt++) {
    (compact.truncation as Record<string, unknown>).finalChars = compactSerialised.length;
    const next = JSON.stringify(compact);
    if (next.length === compactSerialised.length) break;
    compactSerialised = next;
  }
  compactSerialised = JSON.stringify(compact);
  if (compactSerialised.length <= DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH) return compact;
  // A second compacting pass is deliberately still meaningful: it retains
  // one changed stage, source/TORCH evidence, feedback, every answer, and
  // every comparison rather than falling back to empty placeholders.
  const emergency = {
    omissionNotice: "Provider budget reached twice. Minimal bounded excerpts are shown; omitted bulk remains in preserved snapshots for teacher review.",
    timeline: Array.isArray(compact.timeline) ? compact.timeline.slice(0, 4) : [],
    climb: {
      changedStages: compact.climb.changedStages.slice(0, 1),
      sourceChanges: {
        added: compact.climb.sourceChanges.added.slice(0, 1),
        removed: compact.climb.sourceChanges.removed.slice(0, 1),
        edited: compact.climb.sourceChanges.edited.slice(0, 1),
      },
      torchChanges: {
        added: compact.climb.torchChanges.added.slice(0, 1),
        removed: compact.climb.torchChanges.removed.slice(0, 1),
        studentMessageCount: compact.climb.torchChanges.studentMessageCount,
        aiResponseCount: compact.climb.torchChanges.aiResponseCount,
        addedStudentMessages: compact.climb.torchChanges.addedStudentMessages.slice(0, 1),
        addedAiResponses: compact.climb.torchChanges.addedAiResponses.slice(0, 1),
        timing: compact.climb.torchChanges.timing,
      },
    },
    feedback: {
      formative: compact.feedback.formative.slice(0, 1),
      summative: compact.feedback.summative.slice(0, 1),
      answer1: excerpt(compact.feedback.answer1, 80),
      answer2: excerpt(compact.feedback.answer2, 80),
    },
    answers: {
      answer1: excerpt(compact.answers.answer1, 240),
      aiFeedback1: excerpt(compact.answers.aiFeedback1, 80),
      answer2: excerpt(compact.answers.answer2, 240),
      aiFeedback2: excerpt(compact.answers.aiFeedback2, 80),
      finalAnswer: excerpt(compact.answers.finalAnswer, 240),
      comparisons: compact.answers.comparisons,
      cumulativeComparison: compact.answers.cumulativeComparison,
    },
    truncation: {
      budgetChars: DEVELOPMENT_EVIDENCE_MAX_JSON_LENGTH,
      originalChars,
      identityMinimised: true,
      truncated: true,
      fallbackUsed: true,
      truncatedFields: ["text excerpts", "repeated feedback", "repeated source summaries"],
      omittedFields: ["unchanged bulk", "full stage payloads", "repeated activity"],
      finalChars: 0,
    },
  };
  let emergencySerialised = JSON.stringify(emergency);
  for (let attempt = 0; attempt < 3; attempt++) {
    (emergency.truncation as Record<string, unknown>).finalChars = emergencySerialised.length;
    const next = JSON.stringify(emergency);
    if (next.length === emergencySerialised.length) break;
    emergencySerialised = next;
  }
  return emergency;
}

function stageText(snapshot: Snapshot | undefined, stage: string): string {
  return contentText(climbStageContent(snapshot)[stage]);
}

function overlap(first: string, second: string) {
  const a = textWords(first);
  const b = textWords(second);
  const bSet = new Set(b);
  const aSet = new Set(a);
  const shared = [...aSet].filter((word) => bSet.has(word));
  const union = new Set([...aSet, ...bSet]);
  return {
    exact: first.trim() !== "" && first.trim() === second.trim(),
    sharedWordCount: shared.length,
    jaccard: union.size ? Number((shared.length / union.size).toFixed(3)) : 0,
    nearOverlap: shared.length >= 8 && union.size > 0 && shared.length / union.size >= 0.65,
  };
}

function climbStageContent(snapshot: Snapshot | undefined): Record<string, unknown> {
  const entries = snapshot?.payload?.stageEntries;
  const stageContent = Array.isArray(entries) ? Object.fromEntries(entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    return typeof row.stage === "string" ? [[row.stage, row.contentJson ?? null]] : [];
  })) : {};
  if (Array.isArray(snapshot?.payload?.chatMessages)) {
    stageContent.TORCH = snapshot?.payload?.chatMessages;
  }
  return stageContent;
}

function valueExcerpt(value: unknown, maximumLength = 600): string {
  if (typeof value === "string") return boundedText(value, maximumLength);
  if (value === null || value === undefined) return "";
  return boundedText(JSON.stringify(sanitiseEvidenceValue(value)), maximumLength);
}

function flattenFields(value: unknown, prefix = ""): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prefix ? { [prefix]: value } : {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, child]) => {
    if (key === "supportingMaterials" || key === "supportingMaterialCards") return result;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flattenFields(child, path));
    } else {
      result[path] = child;
    }
    return result;
  }, {});
}

function fieldChanges(before: unknown, after: unknown) {
  const beforeFields = flattenFields(before);
  const afterFields = flattenFields(after);
  return Array.from(new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]))
    .sort()
    .flatMap((field) => {
      const hasBefore = field in beforeFields;
      const hasAfter = field in afterFields;
      if (hasBefore && hasAfter && stableJson(beforeFields[field]) === stableJson(afterFields[field])) return [];
      const beforeText = valueExcerpt(beforeFields[field]);
      const afterText = valueExcerpt(afterFields[field]);
      const change = !hasBefore ? "added" : !hasAfter ? "removed" : "rewritten";
      return [{
        field,
        change,
        before: beforeText || null,
        after: afterText || null,
        beforeWordCount: textWords(beforeText).length,
        afterWordCount: textWords(afterText).length,
      }];
    });
}

function sourceRecords(payload: Record<string, unknown>): Array<{ key: string; text: string }> {
  const entries = payload.stageEntries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const content = row.contentJson;
    if (!content || typeof content !== "object" || Array.isArray(content) || row.stage !== "RESEARCH") return [];
    const sources = (content as Record<string, unknown>).entries;
    if (!Array.isArray(sources)) return [];
    return sources.slice(0, 40).flatMap((source, index) => {
      if (!source || typeof source !== "object") return [];
      const item = source as Record<string, unknown>;
      const text = [item.source, item.title, item.findings, item.notes]
        .map((part) => valueExcerpt(part, 500)).filter(Boolean).join(" | ");
      if (!text) return [];
      const rawKey = typeof item.url === "string"
        ? item.url
        : typeof item.source === "string"
          ? item.source
          : typeof item.title === "string" ? item.title : String(index);
      const key = rawKey.replace(/\s+/g, " ").trim().slice(0, 240).toLowerCase();
      return [{ key: key || `source-${index}`, text }];
    });
  });
}

function compareSources(formative: Snapshot | undefined, summative: Snapshot | undefined) {
  const before = sourceRecords(formative?.payload ?? {});
  const after = sourceRecords(summative?.payload ?? {});
  const beforeMap = new Map(before.map((item) => [item.key, item.text]));
  const afterMap = new Map(after.map((item) => [item.key, item.text]));
  const added = [...afterMap].filter(([key]) => !beforeMap.has(key)).map(([, text]) => text);
  const removed = [...beforeMap].filter(([key]) => !afterMap.has(key)).map(([, text]) => text);
  const edited = [...afterMap].flatMap(([key, text]) => {
    const previous = beforeMap.get(key);
    return previous !== undefined && previous !== text ? [{ key, before: previous, after: text }] : [];
  });
  return {
    added,
    removed,
    edited,
    totals: { added: added.length, removed: removed.length, edited: edited.length },
  };
}

function interactionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return valueExcerpt(row.content ?? row.message ?? row.text, 600);
}

function interactionRole(value: unknown): "student" | "ai" | "other" {
  if (!value || typeof value !== "object") return "other";
  const role = (value as Record<string, unknown>).role;
  if (role === "user" || role === "student") return "student";
  if (role === "assistant" || role === "ai") return "ai";
  return "other";
}

function interactionRecordedAt(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>).createdAt;
  if (typeof raw !== "string" && !(raw instanceof Date)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function interactionKey(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  if (typeof row.id === "number" || typeof row.id === "string") return `id:${row.id}`;
  return `${interactionRole(value)}:${interactionText(value)}`;
}

function studentInteractionWords(messages: unknown[]): string[] {
  return messages.flatMap((message) => interactionRole(message) === "student" ? textWords(interactionText(message)) : []);
}

function compareTorchInteractions(formative: Snapshot | undefined, summative: Snapshot | undefined) {
  const beforeRows = Array.isArray(formative?.payload.chatMessages)
    ? formative!.payload.chatMessages.filter((message) => interactionText(message))
    : [];
  const afterRows = Array.isArray(summative?.payload.chatMessages)
    ? summative!.payload.chatMessages.filter((message) => interactionText(message))
    : [];
  const beforeKeys = new Set(beforeRows.map(interactionKey));
  const afterKeys = new Set(afterRows.map(interactionKey));
  const addedRows = afterRows.filter((message) => !beforeKeys.has(interactionKey(message)));
  const removedRows = beforeRows.filter((message) => !afterKeys.has(interactionKey(message)));
  const added = addedRows.map(interactionText);
  const removed = removedRows.map(interactionText);
  const addedStudentMessages = addedRows
    .filter((message) => interactionRole(message) === "student")
    .map(interactionText);
  const addedAiResponses = addedRows
    .filter((message) => interactionRole(message) === "ai")
    .map(interactionText);
  const removedStudentMessages = removedRows
    .filter((message) => interactionRole(message) === "student")
    .map(interactionText);
  const addedDetails = addedRows.map((message) => ({
    role: interactionRole(message),
    text: interactionText(message),
    recordedAt: interactionRecordedAt(message),
  }));
  return {
    added,
    removed,
    totalAdded: added.length,
    totalRemoved: removed.length,
    studentMessageCount: addedStudentMessages.length,
    aiResponseCount: addedAiResponses.length,
    addedStudentMessages,
    addedAiResponses,
    removedStudentMessages,
    addedStudentWordCount: studentInteractionWords(addedRows).length,
    addedDetails,
    timing: addedRows.length > 0 && formative && summative
      ? "after formative feedback and before summative finalisation"
      : "unavailable",
  };
}

export function compareClimbSnapshots(formative?: Snapshot, summative?: Snapshot) {
  const before = climbStageContent(formative);
  const after = climbStageContent(summative);
  const changedStages = stages.filter((stage) => stableJson(before[stage]) !== stableJson(after[stage]));
  if (!formative && !summative) {
    return {
      available: false,
      stagesCompared: [],
      changedStages: [],
      unchangedStages: [],
    };
  }
  const changedStageDetails = changedStages.map((stage) => {
    const beforeText = valueExcerpt(before[stage]);
    const afterText = valueExcerpt(after[stage]);
    const comparison = overlap(beforeText, afterText);
    const change = !before[stage] ? "added" : !after[stage] ? "removed" : "rewritten";
    return {
      stage,
      label: stageLabels[stage],
      change,
      changeType: change,
      before: beforeText || "No recorded content",
      after: afterText || "No recorded content",
      beforeWordCount: textWords(beforeText).length,
      afterWordCount: textWords(afterText).length,
      fieldChanges: fieldChanges(before[stage], after[stage]),
      overlap: comparison,
    };
  });
  return {
    available: Boolean(formative && summative),
    stagesCompared: stages.filter((stage) => stage in before || stage in after),
    changedStages,
    unchangedStages: stages.filter((stage) => (stage in before || stage in after) && !changedStages.includes(stage)),
    changedStageDetails,
    sourceChanges: compareSources(formative, summative),
    torchInteractions: compareTorchInteractions(formative, summative),
  };
}

function interactionCount(messages: unknown[], role: "student" | "ai"): number {
  return messages.filter((message) => interactionRole(message) === role && interactionText(message)).length;
}

function activityTimestamp(value: Date | string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function activityTotals(rows: ActivitySession[], endBeforeMs: number | null = null) {
  const loginSessionIds = rows.map((row) => row.loginSessionId).filter((value): value is string => typeof value === "string");
  return {
    recordedSessions: rows.every((row) => typeof row.loginSessionId === "string")
      ? new Set(loginSessionIds).size
      : null,
    recordedSeconds: rows.reduce((total, row) => {
      const startedAt = activityTimestamp(row.startedAt);
      const endedAt = activityTimestamp(row.endedAt ?? row.lastSeenAt);
      const effectiveEnd = endedAt === null || endBeforeMs === null
        ? endedAt
        : Math.min(endedAt, endBeforeMs);
      return startedAt === null || effectiveEnd === null || effectiveEnd <= startedAt
        ? total
        : total + Math.max(0, Math.floor((effectiveEnd - startedAt) / 1000));
    }, 0),
  };
}

/**
 * Deterministic teacher-facing comparison used by the saved Summative Insight.
 * It is derived from preserved snapshots and recorded activity only; it never
 * calls the AI provider or changes the stored report.
 */
export function buildStudentInsightActivityComparison(
  formative: Snapshot | undefined,
  summative: Snapshot | undefined,
  activity: ActivitySession[],
  totalMessages: unknown[],
  feedbackRounds: number | null,
  formativeGeneratedAt: string | null = null,
): StudentInsightActivityComparison {
  const formativeTimestamp = formative ? activityTimestamp(formative.createdAt) : null;
  const formativeActivity = formativeTimestamp === null
    ? null
    : activity.filter((row) => {
      const startedAt = activityTimestamp(row.startedAt);
      return startedAt !== null && startedAt <= formativeTimestamp;
    });
  const totalActivity = activityTotals(activity);
  const atFormativeActivity = formativeActivity ? activityTotals(formativeActivity, formativeTimestamp) : null;
  const totalTorchQuestions = interactionCount(totalMessages, "student");
  const totalTorchResponses = interactionCount(totalMessages, "ai");
  const formativeMessages = Array.isArray(formative?.payload?.chatMessages)
    ? formative.payload.chatMessages
    : null;
  const atFormativeTorchQuestions = formativeMessages ? interactionCount(formativeMessages, "student") : null;
  const atFormativeTorchResponses = formativeMessages ? interactionCount(formativeMessages, "ai") : null;
  const difference = (total: number | null, before: number | null) =>
    total === null || before === null ? null : Math.max(0, total - before);
  const changedStages = summative && formative
    ? (compareClimbSnapshots(formative, summative).changedStages ?? []).map((stage) =>
      stage === "RESEARCH" ? "Research" : stage === "EMBED" ? "Final Answer" : stage,
    )
    : [];

  return {
    formativeGeneratedAt: formativeGeneratedAt ?? (formative ? snapshotDate(formative.createdAt) : null),
    atFormative: {
      recordedSessions: atFormativeActivity?.recordedSessions ?? null,
      recordedSeconds: atFormativeActivity?.recordedSeconds ?? null,
      torchQuestions: atFormativeTorchQuestions,
      torchResponses: atFormativeTorchResponses,
    },
    sinceFormative: {
      recordedSessions: difference(totalActivity.recordedSessions, atFormativeActivity?.recordedSessions ?? null),
      recordedSeconds: difference(totalActivity.recordedSeconds, atFormativeActivity?.recordedSeconds ?? null),
      torchQuestions: difference(totalTorchQuestions, atFormativeTorchQuestions),
      torchResponses: difference(totalTorchResponses, atFormativeTorchResponses),
    },
    summativeTotal: {
      recordedSessions: totalActivity.recordedSessions,
      recordedSeconds: totalActivity.recordedSeconds,
      torchQuestions: totalTorchQuestions,
      torchResponses: totalTorchResponses,
    },
    finalAnswerFeedbackRoundsUsed: feedbackRounds === null ? null : Math.min(2, Math.max(0, feedbackRounds)),
    changedStages,
  };
}

export function compareFinalAnswers(first: string | null | undefined, second: string | null | undefined) {
  const firstWords = textWords(first);
  const secondWords = textWords(second);
  const firstText = typeof first === "string" ? first.trim() : "";
  const secondText = typeof second === "string" ? second.trim() : "";
  return {
    available: typeof first === "string" && typeof second === "string",
    firstWordCount: firstWords.length,
    secondWordCount: secondWords.length,
    changed: firstText !== secondText,
    addedWords: secondWords.filter((word) => !firstWords.includes(word)),
    removedWords: firstWords.filter((word) => !secondWords.includes(word)),
    overlap: overlap(firstText, secondText),
  };
}

export function finalAnswerFromSnapshot(snapshot?: Snapshot): string {
  const answer = snapshot?.payload?.finalAnswer;
  return typeof answer === "string" ? finalAnswerReadableText(answer) : "";
}

/**
 * This is the only evidence shape sent to the development-analysis provider.
 * It deliberately contains labels and learning records, never student/class IDs
 * or names. Unchanged bulk is omitted because the snapshots remain the evidence
 * of record and can still be inspected by a teacher.
 */
export function buildDevelopmentEvidence(
  snapshots: Snapshot[],
  attempts: AnswerFeedbackAttempt[],
  activity: ActivitySession[] = [],
) {
  const formative = snapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative");
  const summative = snapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative");
  const finalisation = snapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation");
  const formativeAnswer = attempts[0]?.answerSnapshot ?? "";
  const revisedAnswer = attempts[1]?.answerSnapshot ?? "";
  const finalAnswer = finalAnswerFromSnapshot(finalisation);
  const answer1Evidence = boundedText(formativeAnswer, 6_000);
  const answer2Evidence = boundedText(revisedAnswer, 6_000);
  const finalAnswerEvidence = boundedText(finalAnswer, 6_000);
  const climbComparison = compareClimbSnapshots(formative, summative);
  const stageChanges = (climbComparison.changedStageDetails ?? []).map((detail) => {
    const before = stageText(formative, detail.stage);
    const after = stageText(summative, detail.stage);
    const wordDelta = compareFinalAnswers(before, after);
    const torchChanges = detail.stage === "TORCH" ? climbComparison.torchInteractions : null;
    const studentBeforeWords = formative && Array.isArray(formative.payload.chatMessages)
      ? studentInteractionWords(formative.payload.chatMessages)
      : [];
    const studentAfterWords = summative && Array.isArray(summative.payload.chatMessages)
      ? studentInteractionWords(summative.payload.chatMessages)
      : [];
    return {
      ...detail,
      // TORCH contains both student messages and AI responses. Its change
      // counts must never attribute the response words to the student.
      beforeWordCount: detail.stage === "TORCH" ? studentBeforeWords.length : detail.beforeWordCount,
      afterWordCount: detail.stage === "TORCH" ? studentAfterWords.length : detail.afterWordCount,
      addedWordCount: detail.stage === "TORCH"
        ? (torchChanges?.addedStudentWordCount ?? 0)
        : Math.max(0, textWords(after).length - textWords(before).length),
      removedWordCount: detail.stage === "TORCH"
        ? Math.max(0, studentBeforeWords.length - studentAfterWords.length)
        : Math.max(0, textWords(before).length - textWords(after).length),
      addedWords: detail.stage === "TORCH"
        ? textWords(torchChanges?.addedStudentMessages.join(" ") ?? "").slice(0, 120)
        : wordDelta.addedWords.slice(0, 120),
      removedWords: detail.stage === "TORCH"
        ? textWords(torchChanges?.removedStudentMessages?.join(" ") ?? "").slice(0, 120)
        : wordDelta.removedWords.slice(0, 120),
    };
  });
  const timestamps = snapshots.map((snapshot) => ({
    label: snapshot.snapshotKind,
    recordedAt: snapshotDate(snapshot.createdAt),
  })).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const formativeTime = formative ? new Date(formative.createdAt).getTime() : NaN;
  const summativeTime = summative ? new Date(summative.createdAt).getTime() : NaN;
  const intervalStart = Number.isFinite(formativeTime) && Number.isFinite(summativeTime) ? Math.min(formativeTime, summativeTime) : null;
  const intervalEnd = Number.isFinite(formativeTime) && Number.isFinite(summativeTime) ? Math.max(formativeTime, summativeTime) : null;
  const elapsedSeconds = intervalStart !== null && intervalEnd !== null
    ? Math.max(0, Math.round((intervalEnd - intervalStart) / 1000))
    : null;
  const reliableActivity = activity.slice(0, 30).flatMap((row) => {
    const start = new Date(row.startedAt).getTime();
    const end = row.endedAt ? new Date(row.endedAt).getTime() : NaN;
    if (intervalStart === null || intervalEnd === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const clippedStart = Math.max(start, intervalStart);
    const clippedEnd = Math.min(end, intervalEnd);
    return clippedEnd > clippedStart ? [Math.round((clippedEnd - clippedStart) / 1000)] : [];
  });
  const recordedActivity = activity.slice(0, 30).flatMap((row) => {
    const start = new Date(row.startedAt).getTime();
    // A last-seen timestamp is not proof of active time. Only explicitly
    // ended sessions are included in the recorded-time evidence.
    const end = row.endedAt ? new Date(row.endedAt).getTime() : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || intervalStart === null || intervalEnd === null) return [];
    if (intervalStart !== null && intervalEnd !== null && (end < intervalStart || start > intervalEnd)) return [];
    const clippedStart = Math.max(start, intervalStart);
    const clippedEnd = Math.min(end, intervalEnd);
    if (clippedEnd <= clippedStart) return [];
    return [{
      startedAt: new Date(clippedStart).toISOString(),
      endedAt: new Date(clippedEnd).toISOString(),
      durationSeconds: Math.min(86_400, Math.round((clippedEnd - clippedStart) / 1000)),
      activeStage: typeof row.activeStage === "string" ? boundedText(row.activeStage, 80) : null,
    }];
  });
  const changedStageNames = new Set(stageChanges.map((item) => item.stage));
  const feedback = {
    formative: feedbackSummary(formative?.payload.feedback),
    summative: feedbackSummary(summative?.payload.feedback),
    answer1: attempts[0] ? sanitiseEvidenceValue(attempts[0].feedback) : null,
    answer2: attempts[1] ? sanitiseEvidenceValue(attempts[1].feedback) : null,
  };
  const rawEvidence = {
      omissionNotice: "Unchanged bulk and duplicate text are omitted; preserved snapshots and feedback remain the complete evidence of record. Time and length are recorded facts only and must not be used to infer effort or motivation.",
      snapshotTimestamps: timestamps,
      timeline: [
        ...timestamps,
        {
          label: "answer_one_before_ai_feedback_one",
          recordedAt: attempts[0] ? snapshotDate(attempts[0].createdAt) : "unavailable",
        },
        {
          label: "answer_two_after_ai_feedback_one_before_ai_feedback_two",
          recordedAt: attempts[1] ? snapshotDate(attempts[1].createdAt) : "unavailable",
        },
        {
          label: "final_answer_after_ai_feedback_two",
          recordedAt: finalisation ? snapshotDate(finalisation.createdAt) : "unavailable",
        },
      ].sort((a, b) => {
        if (a.recordedAt === "unavailable") return b.recordedAt === "unavailable" ? 0 : 1;
        if (b.recordedAt === "unavailable") return -1;
        return a.recordedAt.localeCompare(b.recordedAt);
      }),
      elapsedSeconds,
      ...(reliableActivity.length > 0 ? {
        recordedActiveTimeSeconds: reliableActivity.reduce((total, seconds) => total + seconds, 0),
      } : {}),
      recordedActivity,
      climb: {
        unchangedStages: stages.filter((stage) => !changedStageNames.has(stage) && (stageText(formative, stage) || stageText(summative, stage))),
        changedStages: stageChanges,
          sourceChanges: "sourceChanges" in climbComparison ? climbComparison.sourceChanges : { added: [], removed: [], edited: [], totals: { added: 0, removed: 0, edited: 0 } },
          torchChanges: "torchInteractions" in climbComparison ? climbComparison.torchInteractions : { added: [], removed: [], totalAdded: 0, totalRemoved: 0 },
      },
      feedback,
      answers: {
        answer1: answer1Evidence,
        aiFeedback1: attempts[0] ? sanitiseEvidenceValue(attempts[0].feedback) : null,
        answer2: answer2Evidence,
        aiFeedback2: attempts[1] ? sanitiseEvidenceValue(attempts[1].feedback) : null,
        finalAnswer: finalAnswerEvidence,
        comparisons: [
          { from: "answer1", to: "answer2", ...compareFinalAnswers(answer1Evidence, answer2Evidence) },
          { from: "answer2", to: "finalAnswer", ...compareFinalAnswers(answer2Evidence, finalAnswerEvidence) },
        ].filter((comparison) => comparison.available),
        cumulativeComparison: {
          from: "answer1",
          to: "finalAnswer",
          ...compareFinalAnswers(answer1Evidence, finalAnswerEvidence),
        },
      },
  };
  const evidence = fitEvidenceBudget(rawEvidence);
  const sourceHash = createHash("sha256").update(stableJson(evidence)).digest("hex");
  return {
    sourceHash,
    evidence,
  };
}

/** Safe structural diagnostics only: never includes student-authored content. */
export function summariseDevelopmentEvidence(
  snapshots: Snapshot[],
  attempts: AnswerFeedbackAttempt[],
  evidence: Record<string, any>,
): DevelopmentEvidenceSummary {
  const climb = evidence.climb && typeof evidence.climb === "object" ? evidence.climb : {};
  const answers = evidence.answers && typeof evidence.answers === "object" ? evidence.answers : {};
  const feedback = evidence.feedback && typeof evidence.feedback === "object" ? evidence.feedback : {};
  const sourceChanges = climb.sourceChanges && typeof climb.sourceChanges === "object" ? climb.sourceChanges : {};
  const torchChanges = climb.torchChanges && typeof climb.torchChanges === "object" ? climb.torchChanges : {};
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  const characters = (value: unknown) => typeof value === "string" ? value.length : 0;
  return {
    formativeClimbPresent: snapshots.some((item) => item.snapshotKind === "climb_formative"),
    summativeClimbPresent: snapshots.some((item) => item.snapshotKind === "climb_summative"),
    changedStageCount: count(climb.changedStages),
    sourceChangeCount: count(sourceChanges.added) + count(sourceChanges.removed) + count(sourceChanges.edited),
    torchChangeCount: count(torchChanges.added) + count(torchChanges.removed),
    formativeFeedbackCount: count(feedback.formative),
    answerOneCharacters: characters(answers.answer1),
    aiFeedbackOnePresent: Boolean(attempts[0]?.feedback),
    answerTwoCharacters: characters(answers.answer2),
    aiFeedbackTwoPresent: Boolean(attempts[1]?.feedback),
    finalAnswerCharacters: characters(answers.finalAnswer),
    answerComparisonCount: count(answers.comparisons),
    truncated: Boolean(evidence.truncation?.truncated),
  };
}

export type DevelopmentClassRecord = {
  sessionId: number;
  studentName?: string | null;
  snapshots: Snapshot[];
  attempts?: AnswerFeedbackAttempt[];
  report?: unknown;
  status?: string | null;
};

/**
 * Builds the teacher-facing class summary from already stored individual
 * records. This deliberately never invokes an AI provider and never turns
 * missing evidence into a positive or negative conclusion.
 */
export function buildDevelopmentClassAggregate(records: DevelopmentClassRecord[]) {
  const totals = {
    eligibleStudents: records.length,
    completedReports: 0,
    notAnalysed: 0,
    comparableClimbs: 0,
    changedClimbs: 0,
    comparableAnswers: 0,
    answersChangedAfterFeedbackOne: 0,
    answersChangedAfterFeedbackTwo: 0,
  };
  const changedStageCounts: Record<string, number> = {};
  const sourceTotals = { added: 0, removed: 0, edited: 0 };
  const torchTotals = { added: 0 };
  const missingEvidence: Record<string, number> = {};
  const statusCounts: Record<string, number> = { "Acted upon": 0, "Partly acted upon": 0, "No related change found": 0, "Not enough evidence": 0, "Teacher review needed": 0, "No action requested": 0, "Not analysed": 0 };
  const answerPatterns: Record<string, number> = {};
  const teacherReview: Array<{ sessionId: number; studentName: string | null; reason: string }> = [];
  const increment = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
  const reportSections = (report: unknown): Record<string, unknown>[] => {
    if (!report || typeof report !== "object" || Array.isArray(report)) return [];
    const row = report as Record<string, unknown>;
    const sections = ["climbDevelopment", "finalAnswerDevelopment"].flatMap((key) => {
      const section = row[key];
      return section && typeof section === "object" && !Array.isArray(section) ? [section as Record<string, unknown>] : [];
    });
    if (Array.isArray(row.feedbackConclusions)) sections.push({ feedbackConclusions: row.feedbackConclusions });
    return sections;
  };

  for (const record of records) {
    const climb = compareClimbSnapshots(
      record.snapshots.find((snapshot) => snapshot.snapshotKind === "climb_formative"),
      record.snapshots.find((snapshot) => snapshot.snapshotKind === "climb_summative"),
    );
    if (!climb.available) increment(missingEvidence, "formative or summative climb snapshot");
    else {
      totals.comparableClimbs++;
      if (climb.changedStages.length) totals.changedClimbs++;
      climb.changedStages.forEach((stage) => increment(changedStageCounts, stage));
      if (climb.sourceChanges) {
        sourceTotals.added += climb.sourceChanges.totals.added;
        sourceTotals.removed += climb.sourceChanges.totals.removed;
        sourceTotals.edited += climb.sourceChanges.totals.edited;
      }
      if (climb.torchInteractions) torchTotals.added += climb.torchInteractions.totalAdded;
    }

    const attempts = record.attempts ?? [];
    const finalAnswer = finalAnswerFromSnapshot(record.snapshots.find((snapshot) => snapshot.snapshotKind === "answer_assessment_finalisation"));
    const answer1 = attempts[0]?.answerSnapshot ?? null;
    const answer2 = attempts[1]?.answerSnapshot ?? null;
    const answer12 = compareFinalAnswers(answer1, answer2);
    const answer23 = compareFinalAnswers(answer2, finalAnswer);
    if (answer12.available || answer23.available) totals.comparableAnswers++;
    if (answer12.available && answer12.changed) totals.answersChangedAfterFeedbackOne++;
    if (answer23.available && answer23.changed) totals.answersChangedAfterFeedbackTwo++;
    if (answer12.available && answer23.available) {
      const pattern = `${answer12.changed ? "changed" : "unchanged"} after feedback one; ${answer23.changed ? "changed" : "unchanged"} after feedback two`;
      increment(answerPatterns, pattern);
    } else {
      increment(missingEvidence, "answer version comparison");
    }

    const sections = reportSections(record.report);
    const conclusions = sections.flatMap((section) => [
      ...(Array.isArray(section.feedbackConclusions) ? section.feedbackConclusions : []),
      ...(Array.isArray(section.findings)
        ? section.findings.filter((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).status === "string")
        : []),
    ]);
    if (!record.report || sections.length === 0 || conclusions.length === 0) {
      totals.notAnalysed++;
      statusCounts["Not analysed"]++;
      continue;
    }
    totals.completedReports++;
    for (const item of conclusions) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const status = (item as Record<string, unknown>).status;
        if (typeof status === "string") {
          increment(statusCounts, status);
          if (status === "Teacher review needed") {
            teacherReview.push({
              sessionId: record.sessionId,
              studentName: record.studentName ?? null,
              reason: typeof (item as Record<string, unknown>).feedbackPoint === "string"
                ? (item as Record<string, unknown>).feedbackPoint as string
                : "The report requires teacher review.",
            });
          }
        }
    }
  }

  const proportion = (numerator: number, denominator: number) => denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
  return {
    eligibleStudents: totals.eligibleStudents,
    completedReports: totals.completedReports,
    statusCounts,
    comparisons: {
      comparableStudents: totals.comparableClimbs,
      changedStudents: totals.changedClimbs,
      comparableProportion: proportion(totals.comparableClimbs, totals.eligibleStudents),
      changedProportion: proportion(totals.changedClimbs, totals.comparableClimbs),
    },
    commonChangedStages: Object.entries(changedStageCounts)
      .map(([stage, count]) => ({ stage, label: stageLabels[stage as keyof typeof stageLabels] ?? stage, count, proportion: proportion(count, totals.comparableClimbs) }))
      .sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage)),
    sourceChanges: sourceTotals,
    torchInteractionsAdded: torchTotals.added,
    answers: {
      comparableStudents: totals.comparableAnswers,
      changedAfterFeedbackOne: totals.answersChangedAfterFeedbackOne,
      changedAfterFeedbackTwo: totals.answersChangedAfterFeedbackTwo,
      changedAfterFeedbackOneProportion: proportion(totals.answersChangedAfterFeedbackOne, totals.comparableAnswers),
      changedAfterFeedbackTwoProportion: proportion(totals.answersChangedAfterFeedbackTwo, totals.comparableAnswers),
      commonPatterns: Object.entries(answerPatterns).map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
    },
    commonAnswerPatterns: Object.entries(answerPatterns).map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
    missingEvidence,
    teacherReview,
  };
}