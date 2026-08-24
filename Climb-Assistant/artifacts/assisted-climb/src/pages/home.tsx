import { useState, useRef, useEffect } from "react";

export default function Home() {
  const [activeStage, setActiveStage] = useState("TORCH");
  const [chatMessages, setChatMessages] = useState([
    {
      role: "user",
      content: "Can you challenge the idea that Macbeth is driven only by ambition?",
    },
    {
      role: "ai",
      content: "Consider whether fear, insecurity, and external influence also shape Macbeth's actions.",
      bullets: [
        "How do the witches influence his thinking?",
        "What role does Lady Macbeth play?",
        "Could fear motivate his decisions?",
      ],
      reflectionPrompt: "Which interpretation currently feels strongest to you?",
    },
  ]);
  const [chatInput, setChatInput] = useState("");

  const activeClimbs = [
    {
      title: "Macbeth Essay",
      stage: "COMPASS",
      progress: 72,
    },
    {
      title: "Climate Change Inquiry",
      stage: "TORCH",
      progress: 41,
    },
  ];

  const mapQuestions = [
    {
      title: "What is this task asking you to do?",
      placeholder: "Break the task down in your own words...",
    },
    {
      title: "What do you already know about this topic?",
      placeholder: "Record prior knowledge, concepts, examples, or ideas...",
    },
    {
      title: "What might be difficult about this task?",
      placeholder: "Identify possible challenges or areas of uncertainty...",
    },
  ];

  const torchPrompts = [
    "Explain a concept",
    "Challenge my thinking",
    "Compare viewpoints",
    "Generate examples",
    "Test my understanding",
  ];

  const compassChecks = [
    "How confident does this response sound?",
    "What evidence supports this claim?",
    "Could this response be biased?",
    "What still needs checking?",
  ];

  const embedQuestions = [
    "What changed in your understanding?",
    "Where did YOU do the thinking?",
    "How did AI help your learning?",
    "What did you decide not to trust?",
  ];

  const handleInvestigate = () => {
    if (!chatInput.trim()) return;
    
    setChatMessages((prev) => [
      ...prev,
      { role: "user", content: chatInput },
      {
        role: "ai",
        content: "That's an interesting perspective to explore further.",
        bullets: [
          "What evidence can you find to support this new angle?",
          "Are there any counter-arguments to consider?",
        ],
        reflectionPrompt: "How does this change your initial stance?",
      },
    ]);
    setChatInput("");
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleInvestigate();
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              The Assisted Climb
            </h1>
            <p className="text-sm text-neutral-500">
              A guided workspace for learning with AI.
            </p>
          </div>

          <nav className="hidden md:flex items-center gap-8 text-sm text-neutral-600">
            <a href="#dashboard" className="hover:text-black transition-colors" data-testid="link-dashboard">
              Dashboard
            </a>
            <a href="#map" className="hover:text-black transition-colors" data-testid="link-map">
              MAP
            </a>
            <a href="#torch" className="hover:text-black transition-colors" data-testid="link-torch">
              TORCH
            </a>
            <a href="#compass" className="hover:text-black transition-colors" data-testid="link-compass">
              COMPASS
            </a>
            <a href="#embed" className="hover:text-black transition-colors" data-testid="link-embed">
              Final Response
            </a>
          </nav>

          <button className="rounded-2xl bg-black text-white px-5 py-3 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-start-climb">
            Start New Climb
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 pt-10 pb-8">
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-8 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8">
            <div>
              <p className="uppercase tracking-[0.25em] text-xs text-neutral-400 mb-3">
                Your Learning Journey
              </p>

              <h2 className="text-4xl lg:text-5xl font-semibold tracking-tight leading-tight max-w-3xl">
                Continue developing your thinking through guided AI-mediated learning.
              </h2>

              <div className="flex flex-wrap gap-4 mt-8">
                <button className="rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity" data-testid="button-continue-latest">
                  Continue Latest Climb
                </button>

                <button className="rounded-2xl border border-neutral-300 px-6 py-4 text-sm font-medium hover:bg-neutral-100 transition-colors" data-testid="button-view-reflections">
                  View Reflections
                </button>
              </div>
            </div>

            <div className="w-full max-w-sm rounded-[2rem] bg-neutral-100 border border-neutral-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold">Thinking Snapshot</h3>
                <span className="text-xs text-neutral-500">This Week</span>
              </div>

              <div className="space-y-5">
                <Progress label="Verification Activity" value={82} />
                <Progress label="Reflection Completion" value={91} />
                <Progress label="Independent Contribution" value={74} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Active Climbs */}
      <section id="dashboard" className="max-w-7xl mx-auto px-6 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-3xl font-semibold tracking-tight">
            Active Climbs
          </h3>

          <button className="text-sm text-neutral-500 hover:text-black transition-colors" data-testid="button-view-all">
            View All
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {activeClimbs.map((climb, index) => (
            <div
              key={index}
              className="rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm hover:shadow-md transition-shadow"
              data-testid={`card-climb-${index}`}
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs uppercase tracking-[0.2em] text-neutral-400">
                  {climb.stage}
                </span>

                <span className="text-sm text-neutral-500">
                  {climb.progress}% Complete
                </span>
              </div>

              <h4 className="text-2xl font-semibold tracking-tight mb-3">
                {climb.title}
              </h4>

              <div className="h-3 rounded-full bg-neutral-200 overflow-hidden mb-5">
                <div
                  className="h-full bg-black rounded-full"
                  style={{ width: `${climb.progress}%` }}
                ></div>
              </div>

              <button className="rounded-2xl border border-neutral-300 px-5 py-3 text-sm font-medium hover:bg-neutral-100 transition-colors" data-testid={`button-continue-climb-${index}`}>
                Continue Climb
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Journey Bar */}
      <section className="max-w-7xl mx-auto px-6 pb-10">
        <div className="rounded-[2rem] bg-white border border-neutral-200 p-6 shadow-sm flex flex-wrap items-center gap-4 md:gap-6">
          {[
            "MAP",
            "TORCH",
            "COMPASS",
            "EMBED",
          ].map((stage, index) => (
            <div key={stage} className="flex items-center gap-4">
              <div
                className={`rounded-2xl px-5 py-3 text-sm font-semibold transition-colors ${
                  activeStage === stage
                    ? stage === "MAP" ? "bg-neutral-800 text-white" 
                    : stage === "TORCH" ? "bg-amber-500 text-white"
                    : stage === "COMPASS" ? "bg-emerald-500 text-white"
                    : "bg-violet-500 text-white"
                    : "bg-neutral-100 text-neutral-500"
                }`}
                data-testid={`journey-stage-${stage}`}
              >
                {stage}
              </div>

              {index < 3 && (
                <div className="h-px w-10 bg-neutral-300"></div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* MAP */}
      <section id="map" className="max-w-7xl mx-auto px-6 pb-12">
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-neutral-400 mb-2">
                MAP
              </p>
              <h3 className="text-3xl font-semibold tracking-tight">
                Planning & Framing Thinking
              </h3>
            </div>

            <button 
              className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => setActiveStage("TORCH")}
              data-testid="button-unlock-torch"
            >
              Unlock TORCH
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3">
            <div className="lg:col-span-2 p-8 border-r border-neutral-200 space-y-8">
              {mapQuestions.map((question, index) => (
                <div key={index}>
                  <label className="block text-sm font-medium mb-3">
                    {question.title}
                  </label>

                  <textarea
                    className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder={question.placeholder}
                    data-testid={`textarea-map-${index}`}
                  />
                </div>
              ))}
            </div>

            <div className="p-8 bg-neutral-50 space-y-6">
              <div>
                <h4 className="text-2xl font-semibold tracking-tight mb-4">
                  Strong planning improves investigation.
                </h4>

                <p className="text-sm text-neutral-600 leading-relaxed">
                  Before using AI, spend time understanding the task, identifying key concepts, and planning your approach.
                </p>
              </div>

              <InfoCard
                title="Reflection Prompt"
                text="Which part of this task do you currently feel least confident about?"
              />

              <InfoCard
                title="Planning Reminder"
                text="AI becomes more useful when you already have a sense of direction and purpose."
              />
            </div>
          </div>
        </div>
      </section>

      {/* TORCH */}
      <section id="torch" className="max-w-7xl mx-auto px-6 pb-12">
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-amber-500 mb-2">
                TORCH
              </p>
              <h3 className="text-3xl font-semibold tracking-tight">
                Guided AI-Mediated Investigation
              </h3>
            </div>

            <button 
              className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => setActiveStage("COMPASS")}
              data-testid="button-move-compass"
            >
              Move to COMPASS
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12">
            <div className="xl:col-span-3 p-8 border-r border-neutral-200 space-y-4">
              <h4 className="text-xl font-semibold tracking-tight">
                Thinking Notes
              </h4>

              <InfoCard
                title="Insight"
                text="Macbeth may be influenced by fear as much as ambition."
              />

              <InfoCard
                title="Observation"
                text="AI suggested conflicting interpretations of power."
              />
            </div>

            <div className="xl:col-span-6 border-r border-neutral-200 flex flex-col min-h-[650px]">
              <div className="border-b border-neutral-200 px-6 py-5">
                <p className="text-sm font-medium mb-4">
                  What do you need help with?
                </p>

                <div className="flex flex-wrap gap-3">
                  {torchPrompts.map((prompt, index) => (
                    <button
                      key={index}
                      className="rounded-2xl border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-100 transition-colors"
                      data-testid={`button-torch-prompt-${index}`}
                      onClick={() => setChatInput(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 bg-neutral-50 px-6 py-8 space-y-6 overflow-y-auto max-h-[500px]">
                {chatMessages.map((msg, index) => (
                  <div key={index} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "user" ? (
                      <div className="max-w-xl rounded-3xl bg-black text-white px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="max-w-2xl rounded-3xl bg-white border border-neutral-200 px-6 py-5 shadow-sm">
                        <p className="text-sm text-neutral-700 leading-relaxed mb-4 whitespace-pre-wrap">
                          {msg.content}
                        </p>

                        {msg.bullets && msg.bullets.length > 0 && (
                          <ul className="list-disc pl-5 space-y-2 text-sm text-neutral-700 mb-5">
                            {msg.bullets.map((bullet, bIdx) => (
                              <li key={bIdx}>{bullet}</li>
                            ))}
                          </ul>
                        )}

                        {msg.reflectionPrompt && (
                          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4">
                            <p className="text-sm font-medium mb-2 text-amber-900">
                              Reflection Prompt
                            </p>
                            <p className="text-sm text-amber-800">
                              {msg.reflectionPrompt}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="border-t border-neutral-200 bg-white px-6 py-5 flex items-end gap-4">
                <textarea
                  className="flex-1 rounded-2xl border border-neutral-200 p-4 min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                  placeholder="Investigate an idea or explore a perspective..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyPress}
                  data-testid="textarea-torch-chat"
                />

                <button 
                  className="rounded-2xl bg-black text-white px-6 py-4 text-sm font-medium hover:opacity-90 transition-opacity"
                  onClick={handleInvestigate}
                  data-testid="button-torch-investigate"
                >
                  Investigate
                </button>
              </div>
            </div>

            <div className="xl:col-span-3 p-8 bg-neutral-50 space-y-6">
              <h4 className="text-2xl font-semibold tracking-tight">
                Explore ideas without outsourcing your thinking.
              </h4>

              <InfoCard
                title="Investigation Reminder"
                text="Strong learning happens when you actively question and refine ideas during exploration."
              />

              <InfoCard
                title="Prepare for COMPASS"
                text="Begin identifying which ideas require further verification or evidence."
              />
            </div>
          </div>
        </div>
      </section>

      {/* COMPASS */}
      <section id="compass" className="max-w-7xl mx-auto px-6 pb-12">
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-500 mb-2">
              COMPASS
            </p>

            <h3 className="text-3xl font-semibold tracking-tight">
              Verification & Epistemic Judgement
            </h3>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            <div className="p-8 border-r border-neutral-200 space-y-5">
              <h4 className="text-xl font-semibold tracking-tight">
                Verification Activities
              </h4>

              {compassChecks.map((check, index) => (
                <div
                  key={index}
                  className="rounded-2xl border border-neutral-200 p-5"
                >
                  <p className="text-sm font-medium mb-3">{check}</p>

                  <textarea
                    className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[100px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Record your evaluation here..."
                    data-testid={`textarea-compass-${index}`}
                  />
                </div>
              ))}
            </div>

            <div className="p-8 bg-neutral-50 space-y-6">
              <h4 className="text-2xl font-semibold tracking-tight">
                Confidence is not the same as accuracy.
              </h4>

              <InfoCard
                title="Trust Marker"
                text="Label outputs as Verified, Needs Checking, Unclear, or Potentially Misleading."
              />

              <InfoCard
                title="Critical Reflection"
                text="What assumptions might this AI response be making?"
              />
            </div>
          </div>
        </div>
      </section>

      {/* EMBED */}
      <section id="embed" className="max-w-7xl mx-auto px-6 pb-20">
        <div className="rounded-[2rem] bg-white border border-neutral-200 shadow-sm overflow-hidden">
          <div className="border-b border-neutral-200 px-8 py-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-violet-500 mb-2">
                Final Response
              </p>

              <h3 className="text-3xl font-semibold tracking-tight">
                Reflection, Internalisation & Ownership
              </h3>
            </div>

            <button 
              className="rounded-2xl bg-black text-white px-6 py-3 text-sm font-medium hover:opacity-90 transition-opacity"
              onClick={() => setActiveStage("EMBED")}
              data-testid="button-complete-climb"
            >
              Complete Climb
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            <div className="p-8 border-r border-neutral-200 space-y-6">
              {embedQuestions.map((question, index) => (
                <div key={index}>
                  <label className="block text-sm font-medium mb-3">
                    {question}
                  </label>

                  <textarea
                    className="w-full rounded-2xl border border-neutral-200 p-4 min-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-black/10"
                    placeholder="Reflect on your learning here..."
                    data-testid={`textarea-embed-${index}`}
                  />
                </div>
              ))}
            </div>

            <div className="p-8 bg-neutral-50 flex flex-col justify-between">
              <div>
                <h4 className="text-3xl font-semibold tracking-tight mb-4">
                  Climb Complete
                </h4>

                <p className="text-neutral-600 leading-relaxed mb-8">
                  Learning is not just what AI produces — it is what you understand, question, and make your own.
                </p>

                <div className="space-y-4">
                  <InfoCard
                    title="MAP"
                    text="You planned and framed your thinking before using AI."
                  />

                  <InfoCard
                    title="TORCH"
                    text="You explored and investigated ideas with guided AI support."
                  />

                  <InfoCard
                    title="COMPASS"
                    text="You verified, questioned, and evaluated information critically."
                  />
                </div>
              </div>

              <button className="mt-10 rounded-2xl border border-neutral-300 px-6 py-4 text-sm font-medium hover:bg-neutral-100 transition-colors" data-testid="button-export-learning">
                Export Learning Summary
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Progress({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-2">
        <span className="font-medium text-neutral-700">{label}</span>
        <span className="text-neutral-500">{value}%</span>
      </div>

      <div className="h-2 rounded-full bg-neutral-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-black transition-all duration-500 ease-out"
          style={{ width: `${value}%` }}
        ></div>
      </div>
    </div>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium mb-2">{title}</p>
      <p className="text-sm text-neutral-600 leading-relaxed">{text}</p>
    </div>
  );
}
