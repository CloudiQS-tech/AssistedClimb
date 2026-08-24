export type QuestionType =
  | "Factual"
  | "Conceptual"
  | "Analytical"
  | "Evaluative"
  | "Creative"
  | "Help/Clarify"
  | "Other";

export const QUESTION_TYPE_META: Record<
  QuestionType,
  { color: string; description: string; examples: string[] }
> = {
  Factual: {
    color: "bg-blue-100 text-blue-700 border-blue-200",
    description: "Recalling facts, definitions, dates, names",
    examples: ["What is photosynthesis?", "When did World War II end?", "Who was Charles Darwin?"],
  },
  Conceptual: {
    color: "bg-sky-100 text-sky-700 border-sky-200",
    description: "Understanding how or why something works",
    examples: ["Why does the heart pump blood?", "How does gravity work?", "Explain how osmosis happens."],
  },
  Analytical: {
    color: "bg-amber-100 text-amber-700 border-amber-200",
    description: "Comparing, connecting, or breaking down ideas",
    examples: ["How did the Treaty of Versailles affect Germany?", "Compare aerobic and anaerobic respiration.", "What factors led to the French Revolution?"],
  },
  Evaluative: {
    color: "bg-orange-100 text-orange-700 border-orange-200",
    description: "Making judgements or weighing evidence",
    examples: ["To what extent was Stalin responsible?", "How significant was the printing press?", "Was dropping the atomic bomb justified?"],
  },
  Creative: {
    color: "bg-violet-100 text-violet-700 border-violet-200",
    description: "Planning, designing, or generating ideas",
    examples: ["How could I structure my answer?", "What might happen if CO₂ levels doubled?", "How should I plan my essay?"],
  },
  "Help/Clarify": {
    color: "bg-neutral-100 text-neutral-600 border-neutral-200",
    description: "Asking for guidance or expressing confusion",
    examples: ["I don't understand what you mean.", "Can you explain that differently?", "I'm confused about the difference between…"],
  },
  Other: {
    color: "bg-neutral-100 text-neutral-400 border-neutral-200",
    description: "General or unclassified messages",
    examples: ["OK", "Thanks", "Got it"],
  },
};

export const QUESTION_TYPES = Object.keys(QUESTION_TYPE_META) as QuestionType[];

export function classifyQuestion(text: string): QuestionType {
  const t = text.toLowerCase().trim();

  // Help / clarification — check first so "I don't understand why..." doesn't go to Conceptual
  if (
    /i (don'?t|do not) (understand|know how|get)/.test(t) ||
    /i'?m (confused|not sure|struggling|lost|stuck)/.test(t) ||
    /can you (help|clarify|explain to me)/.test(t) ||
    /i need (help|clarification)/.test(t) ||
    /not sure (how|what|why|if)/.test(t) ||
    /what do you mean/.test(t)
  ) {
    return "Help/Clarify";
  }

  // Evaluative — judgement, significance, extent
  if (
    /to what extent/.test(t) ||
    /how (significant|important|effective|successful|useful|reliable|valid|justified)/.test(t) ||
    /was (it|this|he|she|they) (justified|successful|effective|right|wrong|important)/.test(t) ||
    /should (we|they|he|she|i|it)/.test(t) ||
    /is it (fair|right|wrong|better|worse|justified)/.test(t) ||
    /evaluate|assess|judge|weigh/.test(t) ||
    /which is (better|worse|more|less)/.test(t) ||
    /do you think|what do you think/.test(t) ||
    /how much (did|does|do|has)/.test(t) ||
    /overall,? (was|is|were|are)/.test(t)
  ) {
    return "Evaluative";
  }

  // Analytical — comparing, connecting, examining
  if (
    /compare|contrast|difference between|similarities between/.test(t) ||
    /how (did|does|do) .{0,40} (affect|impact|influence|lead to|cause|result in)/.test(t) ||
    /what (factors|causes|reasons|led|contributed)/.test(t) ||
    /how (did|does|do) .{0,40} relate/.test(t) ||
    /what (is|was|were) the (connection|relationship|link) between/.test(t) ||
    /analys[ei]|break (it |this |that )?down|examine/.test(t) ||
    /why (did|does|do|was|were|is|are) .{0,40} (happen|occur|change|develop)/.test(t)
  ) {
    return "Analytical";
  }

  // Conceptual — understanding, explanation, causation
  if (
    /^why /.test(t) ||
    /^how (does|do|did) /.test(t) ||
    /explain (how|why|what|the)/.test(t) ||
    /what (causes?|caused|creates?|created|makes?|made)/.test(t) ||
    /what (happens?|happened) (when|if|after|before|as)/.test(t) ||
    /how (is|are|was|were) .{0,40} different/.test(t) ||
    /what('?s| is) the (concept|idea|theory|principle|meaning|significance) of/.test(t) ||
    /how (is|are|was|were) .{0,40} connected/.test(t)
  ) {
    return "Conceptual";
  }

  // Creative — generating, planning, designing
  if (
    /how (could|can|might|would) i/.test(t) ||
    /what (would|might|could) (happen|i|we|they)/.test(t) ||
    /how (should|could) (i|we) (structure|plan|organise|organize|write|draft|design)/.test(t) ||
    /suggest|brainstorm|come up with|generate ideas/.test(t) ||
    /what (could|would) (a|an|my|the) (good|strong|effective)/.test(t) ||
    /if (i|we) were to/.test(t)
  ) {
    return "Creative";
  }

  // Factual — retrieval of specific facts
  if (
    /^what (is|are|was|were) /.test(t) ||
    /^who (is|was|were|are) /.test(t) ||
    /^when (did|was|were|is|are) /.test(t) ||
    /^where (is|was|were|did) /.test(t) ||
    /^define |^what does .{0,40} mean|^what('?s| is) the definition/.test(t) ||
    /^which (country|person|event|year|group|side|nation)/.test(t) ||
    /^how (many|much|long|far|old) /.test(t) ||
    /^list (the|some|a few|key)/.test(t) ||
    /^name (the|some|a)/.test(t)
  ) {
    return "Factual";
  }

  return "Other";
}

export function classifyMessages(
  messages: Array<{ role: string; content: string }>
): Record<QuestionType, number> {
  const counts: Record<QuestionType, number> = {
    Factual: 0,
    Conceptual: 0,
    Analytical: 0,
    Evaluative: 0,
    Creative: 0,
    "Help/Clarify": 0,
    Other: 0,
  };
  for (const m of messages) {
    if (m.role === "user") {
      counts[classifyQuestion(m.content)]++;
    }
  }
  return counts;
}
