import type { SafeguardingCategory, SafeguardingProviderSignal } from "@workspace/db";

export type LocalSafeguardingMatch = {
  category: SafeguardingCategory;
  ruleId: string;
  excerpt: string;
  surroundingContext: string;
};

export type NormalizedProviderSignal = SafeguardingProviderSignal;

export const PROVIDER_OUTPUT_BLOCK_CATEGORY = "assistant_output_blocked";

export function providerOutputBlockedSignal(
  provider: NormalizedProviderSignal["provider"],
): NormalizedProviderSignal {
  return {
    provider,
    categories: [PROVIDER_OUTPUT_BLOCK_CATEGORY],
  };
}

type LocalRule = {
  id: string;
  category: SafeguardingCategory;
  pattern: RegExp;
};

const LOCAL_RULES: LocalRule[] = [
  {
    id: "local.self_harm.direct_intent",
    category: "self_harm_or_suicide",
    pattern: /\b(?:i|i'm|i am|i've|i have been)\s+(?:thinking (?:about|of)\s+(?:suicide|killing myself|ending my life)|(?:want|plan|intend|am going|will|might)\s+to\s+(?:die|kill myself|end my life|take my own life|hurt myself|harm myself|cut myself)|(?:have been|keep)\s+(?:cutting|hurting|harming) myself|wish i (?:was|were) dead|(?:do not|don't) want to be alive)\b/iu,
  },
  {
    id: "local.immediate_danger.first_person",
    category: "immediate_danger",
    pattern: /\b(?:i am|i'm|i feel)\s+(?:in immediate danger|not safe right now|afraid to go home (?:today|tonight))\b|\b(?:i need help right now because|someone is here to hurt me)\b/iu,
  },
  {
    id: "local.sexual_harm.first_person",
    category: "sexual_abuse_or_exploitation",
    pattern: /\b(?:someone|he|she|they|my\s+(?:teacher|coach|relative|partner|parent))\s+(?:has\s+)?(?:touched|is touching|made|forced|pressured)\s+me\s+(?:sexually|without my consent|to (?:send|share|show) (?:nudes|naked photos|sexual pictures|intimate pictures))\b|\b(?:i am|i'm|i was|i have been)\s+(?:being\s+)?(?:sexually abused|groomed)\b/iu,
  },
  {
    id: "local.coercion_or_blackmail.first_person",
    category: "grooming_coercion_or_blackmail",
    pattern: /\b(?:someone|he|she|they|a person)\s+(?:is|are|has been|was|keeps)\s+(?:pressuring|forcing|coercing|blackmailing|threatening)\s+me\b|\b(?:someone|he|she|they)\s+(?:threatened|is threatening|are threatening|said)\s+to\s+(?:share|post|send)\s+(?:my|the)\s+(?:nudes|private pictures|intimate photos)\b/iu,
  },
  {
    id: "local.harm_by_another.first_person",
    category: "harm_by_another_person",
    pattern: /\b(?:my\s+(?:mum|mom|mother|dad|father|parent|carer|partner|teacher|coach|relative)|someone|he|she|they)\s+(?:is|has been|keeps|was)?\s*(?:hitting|beating|hurting|abusing|threatening)\s+me\b|\b(?:i am|i'm|i was|i have been)\s+(?:being\s+)?(?:hurt|beaten|abused|threatened)\s+by\s+(?:someone|him|her|them|my\s+\w+)\b/iu,
  },
  {
    id: "local.serious_violence.direct_threat",
    category: "serious_violence_or_threat",
    pattern: /\b(?:i|i'm|i am)\s+(?:going to|plan to|will|intend to|want to)\s+(?:kill|shoot|stab|attack|seriously hurt)\s+(?:myself|someone|him|her|them|my\s+(?:classmate|teacher|parent|partner|friend))\b|\b(?:someone|he|she|they|my\s+\w+)\s+(?:threatened|is threatening)\s+to\s+(?:kill|shoot|stab|seriously hurt)\s+me\b/iu,
  },
];

function cleanSnippet(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function findLocalSafeguardingMatch(text: string): LocalSafeguardingMatch | null {
  if (typeof text !== "string" || !text.trim()) return null;

  for (const rule of LOCAL_RULES) {
    const match = rule.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const leadIn = text.slice(Math.max(0, match.index - 140), match.index);
    if (/\b(?:the|a|this)\s+(?:character|narrator|speaker|protagonist)\s+(?:says|said|writes|wrote|thinks|thought|asks|asked)\s*[,;:]?\s*['"]?\s*$/iu.test(leadIn)) {
      continue;
    }
    const matchEnd = match.index + match[0].length;
    const start = Math.max(0, match.index - 220);
    const end = Math.min(text.length, matchEnd + 220);
    const excerpt = cleanSnippet(text.slice(start, end)).slice(0, 700);
    return {
      category: rule.category,
      ruleId: rule.id,
      excerpt,
      surroundingContext: "",
    };
  }

  return null;
}

export const SAFEGUARDING_CHAT_REPLY =
  "Thank you for sharing this. I can't respond to this kind of message here, but a trusted adult or your school's safeguarding lead can help. If you or someone else is in immediate danger, contact emergency services now.";

export function redactSafeguardingProviderHistory(
  history: ReadonlyArray<{
    role: string;
    content: string;
    providerSafetyFlagged?: boolean;
  }>,
): Array<{ role: "assistant" | "user"; content: string }> {
  return history.map(({ role, content, providerSafetyFlagged }) => {
    const normalizedRole = role === "assistant" ? "assistant" : "user";
    const isSafetyReply = normalizedRole === "assistant" && content === SAFEGUARDING_CHAT_REPLY;
    const shouldOmit = providerSafetyFlagged === true
      || isSafetyReply
      || findLocalSafeguardingMatch(content) !== null;
    return {
      role: normalizedRole,
      content: shouldOmit ? "[Earlier message omitted.]" : content,
    };
  });
}

const STAGE_TEXT_FIELDS: Record<string, readonly string[]> = {
  MAP: ["taskUnderstanding", "priorKnowledge", "knowledgeGaps", "enquiryQuestions"],
  COMPASS: ["check1", "check2", "check3", "check4", "check5"],
  EMBED: ["finalAnswer", "q1", "q2", "q3", "q4"],
};

function plainTextFromAnswer(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractSubmittedClimbText(stage: string, content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "";
  const data = content as Record<string, unknown>;
  const values: string[] = [];

  const add = (value: unknown, html = false) => {
    if (typeof value !== "string") return;
    const cleaned = html ? plainTextFromAnswer(value) : value.trim();
    if (cleaned) values.push(cleaned);
  };

  if (stage === "RESEARCH") {
    const entries = data.entries;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        for (const key of [
          "sourceDetails",
          "findings",
          "importantPoints",
          "reliability",
          "usage",
          "combinedLearning",
        ]) {
          add(record[key]);
        }
      }
    }
  } else {
    for (const key of STAGE_TEXT_FIELDS[stage] ?? []) {
      add(data[key], stage === "EMBED" && key === "finalAnswer");
    }
  }

  return values.join("\n").slice(0, 50_000);
}

const AZURE_SIGNAL_CATEGORIES = new Set([
  "hate",
  "harassment",
  "self_harm",
  "sexual",
  "violence",
  "dangerous_content",
  "child_safety",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export const AI_OUTPUT_SAFETY_FALLBACK =
  "I can't provide a safe reply to that request right now. Please rephrase it or ask your teacher for help.";

export function isAzureOutputSafetyBlocked(value: unknown): boolean {
  const root = record(value);
  if (root?.choices && Array.isArray(root.choices)) {
    return root.choices.some((choiceValue) => {
      const choice = record(choiceValue);
      if (!choice) return false;
      if (choice.finish_reason === "content_filter" || choice.finishReason === "content_filter") {
        return true;
      }
      const refusal = record(choice.message)?.refusal;
      if (typeof refusal === "string" && refusal.trim()) return true;
      const filters = record(choice.content_filter_results);
      return Boolean(filters && Object.values(filters).some(
        (filter) => record(filter)?.filtered === true,
      ));
    });
  }
  return false;
}

const GEMINI_OUTPUT_BLOCK_REASONS = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

export function isGeminiOutputSafetyBlocked(value: unknown): boolean {
  const candidates = record(value)?.candidates;
  if (!Array.isArray(candidates)) return false;
  return candidates.some((candidateValue) => {
    const candidate = record(candidateValue);
    if (!candidate) return false;
    if (
      typeof candidate.finishReason === "string"
      && GEMINI_OUTPUT_BLOCK_REASONS.has(candidate.finishReason)
    ) {
      return true;
    }
    const ratings = candidate.safetyRatings;
    return Array.isArray(ratings) && ratings.some(
      (rating) => record(rating)?.blocked === true,
    );
  });
}

export function isExplicitClimbSubmission(submission: unknown, content: unknown): boolean {
  if (submission !== true) return false;
  const marker = record(record(content)?._studentCompletion);
  const markedAt = marker?.markedAt;
  return marker?.complete === true
    && typeof markedAt === "string"
    && markedAt.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(markedAt)
    && Number.isFinite(Date.parse(markedAt));
}

export function normalizeAzurePromptSafetySignals(value: unknown): NormalizedProviderSignal[] {
  const root = record(value);
  const results = root?.prompt_filter_results;
  if (!Array.isArray(results)) return [];

  const categories = new Set<string>();
  for (const result of results) {
    const filterResults = record(record(result)?.content_filter_results);
    if (!filterResults) continue;
    for (const [category, resultValue] of Object.entries(filterResults)) {
      const normalized = category.toLocaleLowerCase().replace(/[^a-z_]/gu, "_");
      if (AZURE_SIGNAL_CATEGORIES.has(normalized) && record(resultValue)?.filtered === true) {
        categories.add(normalized);
      }
    }
  }

  return categories.size
    ? [{ provider: "azure", categories: [...categories].sort() }]
    : [];
}

const GEMINI_SIGNAL_CATEGORIES = new Set([
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CSE",
]);

export function normalizeGeminiPromptSafetySignals(value: unknown): NormalizedProviderSignal[] {
  const root = record(value);
  const promptFeedback = record(root?.promptFeedback);
  if (promptFeedback?.blockReason !== "SAFETY") return [];

  const categories = new Set<string>();
  const ratings = promptFeedback.safetyRatings;
  if (Array.isArray(ratings)) {
    for (const rating of ratings) {
      const item = record(rating);
      if (
        typeof item?.category === "string"
        && GEMINI_SIGNAL_CATEGORIES.has(item.category)
        && item.blocked === true
      ) {
        categories.add(item.category);
      }
    }
  }
  if (categories.size === 0) categories.add("UNSPECIFIED_PROMPT_SAFETY");

  return [{ provider: "gemini", categories: [...categories].sort() }];
}