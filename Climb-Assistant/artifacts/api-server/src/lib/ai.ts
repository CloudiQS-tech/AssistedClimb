import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { decrypt } from "./crypto";

/** Strip markdown formatting characters the AI sometimes outputs despite instructions. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, "")   // bold
    .replace(/\*/g, "")      // italic / emphasis
    .replace(/__/g, "")      // bold alt
    .replace(/_([^_]+)_/g, "$1") // italic alt
    .replace(/#+\s/g, "")   // headings
    .replace(/`/g, "")       // code
    .trim();
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface TaskContext {
  title: string;
  question: string;
  notes?: string | null;
  bloomLevels?: string[];
  successCriteria?: string[];
  keyVocabulary?: string[];
  suggestedSources?: string[];
}

export interface MapContent {
  taskUnderstanding?: string;
  priorKnowledge?: string[];
  knowledgeGaps?: string[];
  enquiryQuestions?: string[];
}

export interface ConversationContext {
  turnCount: number;
  bloomCounts: Record<string, number>;
}

export interface OrgAiConfig {
  aiProvider: string | null;
  aiKeyEncrypted: string | null;
  azureEndpoint: string | null;
}

function resolveAiCredentials(orgConfig?: OrgAiConfig | null): {
  provider: string;
  apiKey: string;
  azureEndpoint: string | undefined;
} {
  if (orgConfig?.aiProvider && orgConfig.aiKeyEncrypted) {
    const apiKey = decrypt(orgConfig.aiKeyEncrypted);
    return {
      provider: orgConfig.aiProvider.toLowerCase(),
      apiKey,
      azureEndpoint: orgConfig.azureEndpoint ?? undefined,
    };
  }
  const provider = process.env.AI_PROVIDER?.toLowerCase();
  const apiKey = process.env.AI_API_KEY;
  if (!provider || !apiKey) {
    throw new Error("AI not configured. The school IT admin must set the AI provider and API key.");
  }
  return {
    provider,
    apiKey,
    azureEndpoint: process.env.AZURE_ENDPOINT,
  };
}

const BLOOM_INSTRUCTIONS: Record<string, string> = {
  Knowledge: `The student has selected KNOWLEDGE mode — they want to recall facts, definitions, key terms, or foundational information.
Your role in this mode:
- Help them retrieve and articulate what they already know before giving them anything new.
- Ask them what they already know about the term or topic first.
- Provide definitions, key terms, or facts only to fill genuine gaps — not to replace their thinking.
- Do NOT analyse, evaluate, or complete any part of their task for them.
- Keep your response to a short clarifying explanation (if needed) followed by one question that prompts them to recall or connect further.`,

  Understand: `The student has selected UNDERSTAND mode — they want something explained more clearly.
Your role in this mode:
- Ask them to explain what they currently understand before you intervene.
- Use analogies, simplified language, or step-by-step breakdowns only after hearing their attempt.
- Do NOT explain everything upfront — guide them to construct meaning themselves.
- Ask one question that challenges them to put the idea in their own words or connect it to something familiar.`,

  Apply: `The student has selected APPLY mode — they want to use what they've learned in a context or example.
Your role in this mode:
- Ask them to describe the situation or problem they are working with.
- Guide them through identifying which knowledge applies — do not tell them which to use.
- Suggest they walk through the example step by step, asking one guiding question at each stage.
- Do NOT solve the problem or provide the worked example — scaffold their process only.`,

  Analyse: `The student has selected ANALYSE mode — they want to break something apart, find patterns, causes, or relationships.
Your role in this mode:
- Ask them to identify the parts or components before they try to connect them.
- Prompt them to look for causes, effects, similarities, differences, or patterns.
- Do NOT provide the analysis — ask questions that lead them to find it themselves.
- Focus on one analytical move per response: compare, contrast, trace a cause, identify a pattern.`,

  Evaluate: `The student has selected EVALUATE mode — they want to make a judgement, weigh evidence, or assess an argument.
Your role in this mode:
- Ask them to state their initial position or instinct before examining evidence.
- Guide them to consider evidence on both sides, identify assumptions, and acknowledge counterarguments.
- Do NOT give them a verdict or tell them what to conclude — push them to justify their own position.
- Challenge any unsupported claims with a Socratic question about the evidence behind them.`,

  Create: `The student has selected CREATE mode — they want to produce something original: a plan, argument, design, or piece of writing.
Your role in this mode:
- Ask them what they are trying to produce and who the audience is.
- Help them brainstorm ideas by asking what they already have to work with.
- Guide them through planning and structuring — do NOT draft any part of the work for them.
- Ask one question that helps them clarify their purpose, audience, or key argument before they begin.`,
};

function buildSystemPrompt(
  task?: TaskContext | null,
  bloomLevel?: string | null,
  mapContent?: MapContent | null,
  convCtx?: ConversationContext,
): string {
  // ── Task context ──────────────────────────────────────────────────────────
  let taskSection = "";
  if (task) {
    const lines: string[] = [
      `\n\nTASK CONTEXT — the student is working on the following assignment:`,
      `Title: ${task.title}`,
      `Question: ${task.question}`,
    ];
    if (task.notes) lines.push(`Teacher guidance: ${task.notes}`);
    if (task.bloomLevels?.length) lines.push(`Bloom's levels the teacher wants the student to reach: ${task.bloomLevels.join(", ")}`);
    if (task.successCriteria?.filter(Boolean).length) {
      lines.push(`Success criteria (what the teacher expects the student to demonstrate):\n${task.successCriteria.filter(Boolean).map((c) => `  - ${c}`).join("\n")}`);
    }
    if (task.keyVocabulary?.filter(Boolean).length) {
      lines.push(`Key vocabulary the student should use and understand: ${task.keyVocabulary.filter(Boolean).join(", ")}`);
    }
    if (task.suggestedSources?.filter(Boolean).length) {
      lines.push(`Suggested sources the teacher has recommended:\n${task.suggestedSources.filter(Boolean).map((s) => `  - ${s}`).join("\n")}`);
    }
    lines.push(`\nAll your Socratic questions must be directly relevant to this specific task. Do not ask generic questions — anchor every response to the task, question, and teacher's criteria above.`);
    taskSection = lines.join("\n");
  }

  // ── Student's MAP planning ────────────────────────────────────────────────
  let mapSection = "";
  if (mapContent) {
    const mapLines: string[] = ["\n\nSTUDENT'S MAP PLANNING — completed before this TORCH investigation:"];
    if (mapContent.taskUnderstanding?.trim()) {
      mapLines.push(`Task understanding (their own words): "${mapContent.taskUnderstanding.trim()}"`);
    }
    const pk = mapContent.priorKnowledge?.filter(Boolean) ?? [];
    if (pk.length) {
      mapLines.push(`What they said they already know:\n${pk.map((p) => `  - ${p}`).join("\n")}`);
    }
    const kg = mapContent.knowledgeGaps?.filter(Boolean) ?? [];
    if (kg.length) {
      mapLines.push(`What they identified they need to find out:\n${kg.map((g) => `  - ${g}`).join("\n")}`);
    }
    const eq = mapContent.enquiryQuestions?.filter(Boolean) ?? [];
    if (eq.length) {
      mapLines.push(`Their own enquiry questions for this investigation:\n${eq.map((q) => `  - ${q}`).join("\n")}`);
    }
    mapLines.push(
      `\nUse this planning to personalise every response. If the student explores a question they listed above, acknowledge the connection. If they claim to know something that looks shaky, probe it gently. If they ask about a gap they already identified, validate that self-awareness before helping them explore it. Do not recite their MAP back to them — weave it in naturally.`,
    );
    mapSection = mapLines.join("\n");
  }

  // ── Bloom's level mode ────────────────────────────────────────────────────
  const bloomSection = bloomLevel && BLOOM_INSTRUCTIONS[bloomLevel]
    ? `\n\n${BLOOM_INSTRUCTIONS[bloomLevel]}\n`
    : "";

  // ── Bloom's drift nudge ───────────────────────────────────────────────────
  let driftSection = "";
  if (convCtx && convCtx.turnCount >= 3 && task?.bloomLevels?.length) {
    const highLevels = ["Apply", "Analyse", "Evaluate", "Create"];
    const lowLevels = ["Knowledge", "Understand"];
    const lowCount = lowLevels.reduce((n, l) => n + (convCtx.bloomCounts[l] ?? 0), 0);
    const highCount = highLevels.reduce((n, l) => n + (convCtx.bloomCounts[l] ?? 0), 0);
    const targetHigh = task.bloomLevels.some((l) => highLevels.includes(l));
    if (targetHigh && lowCount >= 3 && highCount < lowCount) {
      const targetHighLevels = task.bloomLevels.filter((l) => highLevels.includes(l)).join(", ");
      driftSection = `\n\nBLOOM'S LEVEL NUDGE: This student has asked ${lowCount} questions at recall or understanding level and only ${highCount} at higher-order levels. The teacher's target includes ${targetHighLevels}. If the student continues at lower levels, acknowledge the knowledge they have built, then invite them upward — for example: "You now have a solid base. Which factor do you think mattered most, and why?" Do this once, naturally, then follow the student's lead.`;
    }
  }

  // ── Escalating reflection depth ───────────────────────────────────────────
  const turnCount = convCtx?.turnCount ?? 0;
  const reflectionGuidance = turnCount < 4
    ? "Early conversation: Reflection Prompts should help the student recall, clarify, or connect to prior knowledge — 'What do you already know about...?', 'Can you put that in your own words?'"
    : turnCount < 8
    ? "Mid conversation: Reflection Prompts should push toward application and pattern-finding — 'How does this connect to...?', 'What would happen if...?', 'What does this tell you about the bigger picture?'"
    : "Advanced conversation: Reflection Prompts should push toward evaluation and synthesis — 'What is the strongest argument for...?', 'If you had to take a position, what would it be and why?', 'What is the most significant implication of what you have found?'";

  return `You are an educational AI tutor — part textbook, part thinking coach.${taskSection}${mapSection}${bloomSection}${driftSection}
Rules you must always follow:

FORMATTING — always follow this:
- Never use asterisks (*), markdown bold, bullet symbols, or any markdown formatting in your responses.
- Write in plain prose only.

FACTUAL LOOKUPS — answer these directly, like a textbook:
- If a student asks for a definition, a date, the name of a person or event, or a factual "what is X?" question, give a clear and accurate answer. Do not withhold basic facts or make them guess.
- You can explain concepts, provide examples, and clarify terminology freely.

DOING THEIR WORK — never do this:
- Never write the student's essay, argument, or answer for them.
- Never produce a list of points they can copy straight into their work.
- If a student asks you to "write my essay" or "give me the answer to the question", redirect them with a Socratic question instead.

GUIDING THINKING — use this when they are analysing, evaluating, or creating:
- Ask one focused question per response — do not flood them with multiple questions.
- Keep responses concise: a short explanation if needed, then your question.
- End every response with a clearly labelled "Reflection Prompt:" — a single question that pushes their thinking one step further.

REFLECTION PROMPT CALIBRATION — ${reflectionGuidance}

TASK CRITERIA — actively weave these into your responses when relevant:
- If the task has success criteria, refer to them naturally when the student's response touches on them. For example: "Your teacher has asked that you can explain X — how would you put that in your own words?"
- If the task has key vocabulary, notice when the student avoids or misuses a key term and gently bring it in. For example: "Your teacher has highlighted the term X as important here — can you explain what it means in this context?"
- If the teacher has given guidance notes, draw on them when guiding the student. For example: "Your teacher suggested thinking about Y — how does that connect to what you've just said?"
- If the task targets specific Bloom's levels, pitch your questions at that level of thinking.

SUGGESTING SOURCES — do this proactively, not only when stuck:
- After answering a factual or conceptual question, naturally recommend 1–2 specific places the student could read further. For example: "To explore this more, BBC Bitesize has a clear page on photosynthesis — worth reading before you form your argument." or "The CGP revision guide covers this topic well if you have access to it."
- Match the source type to the task: for science topics suggest BBC Bitesize, Khan Academy, or relevant museum/institute sites; for history suggest primary source archives, the BBC History site, or named textbooks; for geography suggest national statistics offices, the Met Office, or academic geography sites; for literature suggest the British Library, Sparknotes for context only (not for analysis), or critic databases.
- If the teacher has provided suggested sources, refer to them by name: "Have you tried [source]? Your teacher recommended it specifically for this task."
- Always suggest source types or well-known named sites you are confident exist — never fabricate specific URLs or book ISBNs.
- Keep the suggestion brief (one sentence) and then redirect with a question: "What did you find when you looked?"`;
}

const BLOOM_LEVELS = ["Knowledge", "Understand", "Apply", "Analyse", "Evaluate", "Create"];

const SUGGESTION_PROMPT = (task: TaskContext) =>
  `You are helping a student prepare to investigate a learning task using an AI tutor.

Task title: ${task.title}
Task question: ${task.question}${task.notes ? `\nTeacher notes: ${task.notes}` : ""}

Generate exactly 2 specific starter questions for EACH of the following Bloom's taxonomy levels. The questions must be:
- Directly relevant to this specific task and topic (not generic)
- Written as questions the student would type to an AI tutor
- Appropriate for the thinking level

Also generate exactly 3 "thinkingNotes" — short coaching tips (1–2 sentences each) that are specific to THIS task. They should help the student think more deeply about this particular question — not generic AI advice. For example, if the task is about the causes of WW1, a good tip might be: "Think about which cause you find most convincing before you ask the AI — it will help you argue a position rather than just list facts."

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "Knowledge": ["question 1", "question 2"],
  "Understand": ["question 1", "question 2"],
  "Apply": ["question 1", "question 2"],
  "Analyse": ["question 1", "question 2"],
  "Evaluate": ["question 1", "question 2"],
  "Create": ["question 1", "question 2"],
  "thinkingNotes": ["tip 1", "tip 2", "tip 3"]
}`;

export interface TorchSuggestionsResult {
  suggestions: Record<string, string[]>;
  thinkingNotes: string[];
}

export async function generateTorchSuggestions(
  task: TaskContext,
  orgConfig?: OrgAiConfig | null,
): Promise<TorchSuggestionsResult> {
  const { provider, apiKey } = resolveAiCredentials(orgConfig);

  const prompt = SUGGESTION_PROMPT(task);
  let raw = "";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = result.text ?? "";
  } else if (provider === "azure") {
    const endpoint = orgConfig?.azureEndpoint ?? process.env.AZURE_ENDPOINT;
    if (!endpoint) throw new Error("Azure endpoint not configured");
    const client = new OpenAI({ apiKey, baseURL: endpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } });
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "";
  } else {
    throw new Error(`Unknown AI provider: "${provider}"`);
  }

  const parsed = JSON.parse(raw);
  const suggestions: Record<string, string[]> = {};
  for (const level of BLOOM_LEVELS) {
    suggestions[level] = Array.isArray(parsed[level]) ? parsed[level].slice(0, 2) : [];
  }
  const thinkingNotes: string[] = Array.isArray(parsed.thinkingNotes)
    ? parsed.thinkingNotes.slice(0, 3)
    : [];
  return { suggestions, thinkingNotes };
}

export async function callAI(
  message: string,
  history: ChatMessage[],
  task?: TaskContext | null,
  bloomLevel?: string | null,
  orgConfig?: OrgAiConfig | null,
  mapContent?: MapContent | null,
  convCtx?: ConversationContext,
): Promise<string> {
  const { provider, apiKey, azureEndpoint } = resolveAiCredentials(orgConfig);

  if (provider === "gemini") {
    return callGemini(apiKey, message, history, task, bloomLevel, mapContent, convCtx);
  }

  if (provider === "azure") {
    if (!azureEndpoint) {
      throw new Error("Azure endpoint not configured");
    }
    return callAzureOpenAI(apiKey, azureEndpoint, message, history, task, bloomLevel, mapContent, convCtx);
  }

  throw new Error(`Unknown AI provider: "${provider}". Use "gemini" or "azure".`);
}

async function callGemini(
  apiKey: string,
  message: string,
  history: ChatMessage[],
  task?: TaskContext | null,
  bloomLevel?: string | null,
  mapContent?: MapContent | null,
  convCtx?: ConversationContext,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const geminiHistory = history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const chat = ai.chats.create({
    model: "gemini-2.5-flash",
    history: geminiHistory,
    config: {
      systemInstruction: buildSystemPrompt(task, bloomLevel, mapContent, convCtx),
    },
  });

  const result = await chat.sendMessage({ message });
  return result.text ?? "";
}

// ── One-shot raw call (custom system prompt) ─────────────────────────────────

export async function callAIOneShot(
  systemPrompt: string,
  userMessage: string,
  orgConfig?: OrgAiConfig | null,
): Promise<string> {
  const { provider, apiKey, azureEndpoint } = resolveAiCredentials(orgConfig);

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userMessage,
      config: { systemInstruction: systemPrompt },
    });
    return result.text ?? "";
  }

  const client = new OpenAI(
    azureEndpoint
      ? { apiKey, baseURL: azureEndpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } }
      : { apiKey },
  );
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });
  return completion.choices[0]?.message?.content ?? "";
}

export interface StageFeedback {
  stage: string;
  grade: string | null;
  comment: string;
  formativeComment?: string;
  studentContent?: string;
}

const GRADE_LABELS: Record<string, string> = {
  emerging: "Emerging",
  developing: "Developing",
  secure: "Secure",
  exceeding: "Exceeding",
};

function buildSynthesisPrompt(
  studentName: string,
  taskTitle: string,
  taskQuestion: string,
  stageFeedbacks: StageFeedback[],
): string {
  const stageNames: Record<string, string> = {
    MAP: "MAP (Planning & Framing)",
    TORCH: "TORCH (AI-Mediated Investigation)",
    RESEARCH: "RESEARCH (Source Verification)",
    COMPASS: "COMPASS (Check Your Thinking)",
    EMBED: "ANSWER (Final Response)",
  };

  const feedbackSummary = stageFeedbacks
    .filter((f) => f.grade || f.comment || f.formativeComment || f.studentContent)
    .map((f) => {
      const lines = [`Stage: ${stageNames[f.stage] ?? f.stage}`];
      if (f.studentContent) lines.push(`Student work: ${f.studentContent}`);
      if (f.formativeComment) lines.push(`Mid-point formative feedback given: ${f.formativeComment}`);
      if (f.grade) lines.push(`Teacher grade: ${GRADE_LABELS[f.grade] ?? f.grade}`);
      if (f.comment) lines.push(`Teacher summative comment: ${f.comment}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `You are an experienced secondary school teacher writing a professional assessment comment for a student's learning record / MIS (Management Information System) entry.

Student name: ${studentName}
Task title: ${taskTitle}
Task question: ${taskQuestion}

Per-stage teacher assessments:
${feedbackSummary}

Write a professional assessment comment and suggest an overall grade. The comment should:
1. Acknowledge what the student did well across their learning journey
2. Specifically identify what was missing or underdeveloped in the stages where weaknesses were noted
3. Value the PROCESS of learning (planning, investigation, verification, critical thinking) as much as the final output
4. Address the student directly in second person (e.g. "You demonstrated…" not "Dawn demonstrated…")
5. Be 3–5 sentences of plain prose — no asterisks, no bullet points, no markdown formatting of any kind
6. Be honest and specific — not generic praise

Then suggest an overall grade from: Emerging, Developing, Secure, Exceeding — based on the balance of stage grades, weighting each stage equally.

Respond in this exact JSON format:
{
  "comment": "...",
  "grade": "emerging" | "developing" | "secure" | "exceeding"
}`;
}

export interface ClassInsightsInput {
  taskTitle: string;
  taskQuestion: string;
  studentCount: number;
  stageCompletion: Record<string, number>;
  questionTypeCounts: Record<string, number>;
  totalMessages: number;
  torchSamples: string[];
  answerSamples: string[];
  mapSamples: string[];
  compassSamples: string[];
  gradeDistribution: Record<string, Record<string, number>>;
  assessedCount: number;
}

export async function synthesiseClassInsights(
  input: ClassInsightsInput,
  orgConfig?: OrgAiConfig | null,
): Promise<{
  questionTypeInsight: string;
  confidentAreas: string[];
  knowledgeGaps: string[];
  misconceptionQuotes: string[];
  stagePatterns: string[];
  teachingRecommendations: string[];
  nextLessonPlan: string[];
}> {
  const { provider, apiKey } = resolveAiCredentials(orgConfig);

  const total = input.studentCount;
  const stagePct = (stage: string) => total > 0 ? Math.round(((input.stageCompletion[stage] ?? 0) / total) * 100) : 0;
  const qTotal = input.totalMessages || 1;
  const qPct = (t: string) => Math.round(((input.questionTypeCounts[t] ?? 0) / qTotal) * 100);

  const stageNames: Record<string, string> = { MAP: "MAP (Planning)", TORCH: "TORCH (AI Investigation)", RESEARCH: "RESEARCH (Sources)", COMPASS: "COMPASS (Critical Thinking)", EMBED: "ANSWER (Final Response)" };

  const stageCompletionText = ["MAP","TORCH","COMPASS","EMBED","RESEARCH"]
    .map(s => `  ${stageNames[s]}: ${input.stageCompletion[s] ?? 0}/${total} students (${stagePct(s)}%)`)
    .join("\n");

  const qtNames = ["Factual","Conceptual","Analytical","Evaluative","Creative","Help/Clarify","Other"];
  const qtText = qtNames
    .filter(t => (input.questionTypeCounts[t] ?? 0) > 0)
    .map(t => `  ${t}: ${input.questionTypeCounts[t]} (${qPct(t)}%)`)
    .join("\n");

  const gradeText = input.assessedCount > 0
    ? "\nTEACHER ASSESSMENT GRADES BY STAGE:\n" + Object.entries(input.gradeDistribution)
        .map(([stage, counts]) => `  ${stage}: ${Object.entries(counts).map(([g,n]) => `${g}=${n}`).join(", ")}`)
        .join("\n")
    : "\n(No teacher assessments recorded yet)";

  const torchSampleText = input.torchSamples.length > 0
    ? "\nSTUDENT QUESTIONS TO THE AI TUTOR (verbatim, TORCH stage):\n" + input.torchSamples.slice(0,20).map(q => `  - "${q}"`).join("\n")
    : "";

  const mapSampleText = input.mapSamples.length > 0
    ? "\nSTUDENT PLANNING NOTES (MAP stage — what they said they already know and plan to investigate):\n" + input.mapSamples.slice(0,8).map(a => `  - "${a}"`).join("\n")
    : "";

  const compassSampleText = input.compassSamples.length > 0
    ? "\nSTUDENT CRITICAL THINKING CHECKS (COMPASS stage — their self-evaluation responses):\n" + input.compassSamples.slice(0,8).map(a => `  - "${a}"`).join("\n")
    : "";

  const answerSampleText = input.answerSamples.length > 0
    ? "\nSTUDENT FINAL ANSWERS (EMBED stage — first 300 chars each):\n" + input.answerSamples.slice(0,6).map(a => `  - "${a.slice(0,300)}${a.length > 300 ? "…" : ""}"`).join("\n")
    : "";

  const prompt = `You are an experienced secondary school educator conducting a forensic analysis of a class that just completed an AI-assisted inquiry learning task. You have access to their actual written work — use it. Your job is to give the teacher insights they could not easily spot themselves.

TASK TITLE: "${input.taskTitle}"
CENTRAL QUESTION: "${input.taskQuestion}"
CLASS SIZE: ${total} students

STAGE COMPLETION:
${stageCompletionText}

TORCH AI QUESTION TYPES (how students were thinking when they queried the AI tutor):
  Factual = recall / lookup   Conceptual = ideas / meaning   Analytical = causes / patterns
  Evaluative = judging quality or reliability   Creative = hypothetical / synthesis
  Help/Clarification = rephrasing or stuck
Total messages: ${input.totalMessages}
${qtText}${gradeText}${torchSampleText}${mapSampleText}${compassSampleText}${answerSampleText}

ANALYSIS INSTRUCTIONS:
- Every point must be specific to THIS task ("${input.taskQuestion}") and THIS class's actual words — not generic pedagogy.
- For misconceptionQuotes: find 3–5 verbatim phrases or paraphrases from student work that reveal a specific misunderstanding, over-simplification, or gap. Quote them directly with a one-sentence explanation of what the error reveals. If no written work is available, return an empty array.
- For nextLessonPlan: give exactly 3 concrete steps the teacher should take in the NEXT lesson, each as a single actionable sentence naming the specific concept or skill from this task.
- For teachingRecommendations: 4–5 specific interventions tied to what you observed — name the concept, name the stage, suggest the method.

Respond ONLY in this exact JSON format (no markdown, no extra keys):
{
  "questionTypeInsight": "2-3 sentences interpreting what the balance of question types reveals about how this class is thinking. Reference the actual percentages and task content.",
  "confidentAreas": ["3-5 specific topics or sub-concepts these students engage with confidently, drawn directly from their questions and written work"],
  "knowledgeGaps": ["3-5 specific areas of shallow thinking, avoidance, or confusion visible in their actual work — be precise about what they got wrong or skipped"],
  "misconceptionQuotes": ["Direct quote or close paraphrase from student work followed by a dash and one sentence explaining what the error reveals. Example: 'Plants make their own food from soil — conflates nutrient uptake with photosynthesis; student does not distinguish between minerals absorbed through roots and glucose synthesised from light.'"],
  "stagePatterns": ["2-3 observations about where students stalled or rushed — which stage had the most dropoff, what that suggests about difficulty or engagement"],
  "teachingRecommendations": ["4-5 specific, actionable next steps — each names the concept, the stage, and the method. No generic advice."],
  "nextLessonPlan": ["Step 1 for next lesson — one concrete sentence", "Step 2 for next lesson — one concrete sentence", "Step 3 for next lesson — one concrete sentence"]
}`;

  let raw = "";
  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = result.text ?? "{}";
  } else {
    const endpoint = orgConfig?.azureEndpoint ?? process.env.AZURE_ENDPOINT;
    const client = new OpenAI(endpoint ? { apiKey, baseURL: endpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } } : { apiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
  }

  const parsed = JSON.parse(raw);
  return {
    questionTypeInsight: stripMarkdown(parsed.questionTypeInsight ?? ""),
    confidentAreas: (parsed.confidentAreas ?? []).map(stripMarkdown),
    knowledgeGaps: (parsed.knowledgeGaps ?? []).map(stripMarkdown),
    misconceptionQuotes: (parsed.misconceptionQuotes ?? []).map(stripMarkdown),
    stagePatterns: (parsed.stagePatterns ?? []).map(stripMarkdown),
    teachingRecommendations: (parsed.teachingRecommendations ?? []).map(stripMarkdown),
    nextLessonPlan: (parsed.nextLessonPlan ?? []).map(stripMarkdown),
  };
}

export async function synthesiseAssessment(
  studentName: string,
  taskTitle: string,
  taskQuestion: string,
  stageFeedbacks: StageFeedback[],
  orgConfig?: OrgAiConfig | null,
): Promise<{ comment: string; grade: string }> {
  const { provider, apiKey, azureEndpoint } = resolveAiCredentials(orgConfig);

  const prompt = buildSynthesisPrompt(studentName, taskTitle, taskQuestion, stageFeedbacks);

  let raw = "";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = result.text ?? "{}";
  } else {
    const client = new OpenAI(azureEndpoint ? { apiKey, baseURL: azureEndpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } } : { apiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
  }

  const parsed = JSON.parse(raw);
  return {
    comment: stripMarkdown(parsed.comment ?? ""),
    grade: parsed.grade ?? "developing",
  };
}

// ── Formative Feedback Generation ────────────────────────────────────────────

export interface FormativeStageInput {
  stage: string;
  content: string; // human-readable summary of the student's work for this stage
}

export async function generateFormativeFeedback(
  taskTitle: string,
  taskQuestion: string,
  taskNotes: string,
  stages: FormativeStageInput[],
  orgConfig?: OrgAiConfig | null,
): Promise<Record<string, string>> {
  const { provider, apiKey, azureEndpoint } = resolveAiCredentials(orgConfig);

  const stagesWithContent = stages.filter((s) => s.content.trim().length > 0);
  if (stagesWithContent.length === 0) return {};

  const stageBlock = stagesWithContent
    .map((s) => `=== ${s.stage} ===\n${s.content}`)
    .join("\n\n");

  const stageKeys = stagesWithContent.map((s) => s.stage);

  const prompt = `You are an experienced secondary school teacher writing mid-point formative feedback for a student's learning journey.

TASK TITLE: ${taskTitle}
TASK QUESTION: ${taskQuestion}${taskNotes ? `\nTEACHER NOTES: ${taskNotes}` : ""}

The student has produced the following work across their learning stages:

${stageBlock}

Write formative feedback for EACH stage shown above. Each stage's feedback should:
- Be 2-3 sentences of plain prose — no asterisks, no bullet points, no markdown of any kind
- Address the student directly in second person ("You…" not their name)
- Acknowledge what they have done well in that stage
- Identify one specific area to push their thinking further, grounded in the actual content they produced
- Be encouraging but honest — do not give empty praise
- Take into account the full task question and all stages together so the feedback is coherent across the journey

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
${stageKeys.map((k) => `  "${k}": "..."`).join(",\n")}
}`;

  let raw = "";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = result.text ?? "{}";
  } else {
    const client = new OpenAI(
      azureEndpoint
        ? { apiKey, baseURL: azureEndpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } }
        : { apiKey },
    );
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
  }

  const parsed = JSON.parse(raw);
  const result: Record<string, string> = {};
  for (const { stage } of stagesWithContent) {
    if (typeof parsed[stage] === "string" && parsed[stage].trim()) {
      result[stage] = stripMarkdown(parsed[stage]);
    }
  }
  return result;
}

// ── Summative Feedback Per Stage ─────────────────────────────────────────────

export async function generateSummativePerStage(
  taskTitle: string,
  taskQuestion: string,
  taskNotes: string,
  stages: FormativeStageInput[],
  orgConfig?: OrgAiConfig | null,
): Promise<Record<string, { grade: string; comment: string }>> {
  const { provider, apiKey, azureEndpoint } = resolveAiCredentials(orgConfig);

  const stagesWithContent = stages.filter((s) => s.content.trim().length > 0);
  if (stagesWithContent.length === 0) return {};

  const stageBlock = stagesWithContent
    .map((s) => `=== ${s.stage} ===\n${s.content}`)
    .join("\n\n");

  const stageKeys = stagesWithContent.map((s) => s.stage);

  const stageNames: Record<string, string> = {
    MAP: "MAP (Planning & Framing)",
    TORCH: "TORCH (AI-Guided Investigation)",
    RESEARCH: "RESEARCH (Source Verification)",
    COMPASS: "COMPASS (Check Your Thinking)",
    EMBED: "EMBED (Final Response)",
  };

  const prompt = `You are an experienced secondary school teacher writing final summative assessment for each stage of a student's learning journey.

TASK TITLE: ${taskTitle}
TASK QUESTION: ${taskQuestion}${taskNotes ? `\nTEACHER NOTES: ${taskNotes}` : ""}

The student has produced the following work:

${stageBlock}

For EACH stage above, write a summative assessment. Each stage's assessment should:
- Comment: 2-3 sentences of plain prose — no asterisks, no bullet points, no markdown of any kind
- Address the student directly in second person ("You demonstrated…" not their name)
- Be honest and specific about what they achieved and what was missing in that stage
- Grade: one of exactly: "emerging", "developing", "secure", "exceeding" — based on the quality and depth of the work in that stage alone

Grades:
- emerging: very limited engagement, major gaps, little understanding shown
- developing: partial engagement, some understanding but significant gaps
- secure: solid understanding, most elements addressed appropriately
- exceeding: strong depth, critical thinking, goes beyond expectations

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
${stageKeys.map((k) => `  "${k}": { "grade": "developing", "comment": "..." }`).join(",\n")}
}`;

  let raw = "";

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = result.text ?? "{}";
  } else {
    const client = new OpenAI(
      azureEndpoint
        ? { apiKey, baseURL: azureEndpoint, defaultHeaders: { "api-key": apiKey }, defaultQuery: { "api-version": "2024-02-01" } }
        : { apiKey },
    );
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = completion.choices[0]?.message?.content ?? "{}";
  }

  const parsed = JSON.parse(raw);
  const result: Record<string, { grade: string; comment: string }> = {};
  const validGrades = ["emerging", "developing", "secure", "exceeding"];
  for (const { stage } of stagesWithContent) {
    const entry = parsed[stage];
    if (entry && typeof entry === "object") {
      result[stage] = {
        grade: validGrades.includes(entry.grade) ? entry.grade : "developing",
        comment: stripMarkdown(entry.comment ?? ""),
      };
    }
  }
  return result;
}

async function callAzureOpenAI(
  apiKey: string,
  azureEndpoint: string,
  message: string,
  history: ChatMessage[],
  task?: TaskContext | null,
  bloomLevel?: string | null,
  mapContent?: MapContent | null,
  convCtx?: ConversationContext,
): Promise<string> {
  const client = new OpenAI({
    apiKey,
    baseURL: azureEndpoint,
    defaultHeaders: { "api-key": apiKey },
    defaultQuery: { "api-version": "2024-02-01" },
  });

  const systemPrompt = buildSystemPrompt(task, bloomLevel, mapContent, convCtx);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({
      role: (msg.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: msg.content,
    })),
    { role: "user", content: message },
  ];

  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    messages,
  });

  return completion.choices[0]?.message?.content ?? "";
}
