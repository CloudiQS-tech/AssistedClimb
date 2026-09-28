export default function InsightReportContent({ insights }: { insights: any }) {
  return (
    <div className="p-8 space-y-8">
      {insights.questionTypeInsight && (
        <div>
          <p className="text-xs uppercase tracking-widest font-semibold text-amber-500 mb-3">What the questions tell you</p>
          <p className="text-neutral-700 leading-relaxed">{insights.questionTypeInsight}</p>
        </div>
      )}

      {insights.thinkingChoices && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5" data-testid="insight-thinking-choices">
          <p className="text-xs uppercase tracking-widest font-semibold text-amber-700 mb-3">Thinking Choices</p>
          <p className="text-sm text-amber-950 leading-relaxed">{insights.thinkingChoices.summary}</p>
        </div>
      )}

      {((insights.confidentAreas?.length ?? 0) > 0 || (insights.knowledgeGaps?.length ?? 0) > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(insights.confidentAreas?.length ?? 0) > 0 && (
            <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-5">
              <p className="text-xs uppercase tracking-widest font-semibold text-emerald-600 mb-3">Where students seem solid</p>
              <ul className="space-y-2">
                {(insights.confidentAreas as string[]).map((item, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-emerald-900 leading-relaxed">
                    <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-emerald-200 flex items-center justify-center text-[10px] font-bold text-emerald-700">{i + 1}</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(insights.knowledgeGaps?.length ?? 0) > 0 && (
            <div className="rounded-2xl bg-red-50 border border-red-100 p-5">
              <p className="text-xs uppercase tracking-widest font-semibold text-red-500 mb-3">Where gaps appear</p>
              <ul className="space-y-2">
                {(insights.knowledgeGaps as string[]).map((item, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-red-900 leading-relaxed">
                    <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-red-200 flex items-center justify-center text-[10px] font-bold text-red-700">{i + 1}</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(insights.misconceptionQuotes?.length ?? 0) > 0 && (
        <div className="rounded-2xl bg-orange-50 border border-orange-100 p-5">
          <p className="text-xs uppercase tracking-widest font-semibold text-orange-500 mb-3">Misconceptions — in their own words</p>
          <ul className="space-y-3">
            {(insights.misconceptionQuotes as string[]).map((item, i) => {
              const dash = item.indexOf(" — ");
              const quote = dash > -1 ? item.slice(0, dash) : item;
              const explanation = dash > -1 ? item.slice(dash + 3) : "";
              return (
                <li key={i} className="space-y-1">
                  <p className="text-sm font-medium text-orange-900 italic">"{quote}"</p>
                  {explanation && <p className="text-xs text-orange-700 leading-relaxed">{explanation}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(insights.stagePatterns?.length ?? 0) > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest font-semibold text-sky-500 mb-3">Stage patterns</p>
          <ul className="space-y-2">
            {(insights.stagePatterns as string[]).map((item, i) => (
              <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                <span className="mt-0.5 shrink-0 text-sky-300">◆</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(insights.teachingRecommendations?.length ?? 0) > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest font-semibold text-neutral-500 mb-3">Teaching recommendations</p>
          <ol className="space-y-2">
            {(insights.teachingRecommendations as string[]).map((item, i) => (
              <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-neutral-200 flex items-center justify-center text-[10px] font-bold text-neutral-600">{i + 1}</span>
                {item}
              </li>
            ))}
          </ol>
        </div>
      )}

      {(insights.nextLessonPlan?.length ?? 0) > 0 && (
        <div className="rounded-2xl bg-neutral-900 text-white p-6">
          <p className="text-xs uppercase tracking-widest font-semibold text-neutral-400 mb-4">Next lesson — suggested plan</p>
          <ol className="space-y-3">
            {(insights.nextLessonPlan as string[]).map((item, i) => (
              <li key={i} className="flex gap-4 leading-relaxed">
                <span className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-white text-neutral-900 flex items-center justify-center text-xs font-bold">
                  {i + 1}
                </span>
                <span className="text-sm text-neutral-100 leading-relaxed">{item}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}