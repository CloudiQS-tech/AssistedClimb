const UK_TIME_ZONE = "Europe/London";
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function isValidTaskDueDate(value: string): boolean {
  return parseDateOnly(value) !== null;
}

function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TIME_ZONE,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(offset);
  if (!match) return 0;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

function londonMidnightUtc(year: number, month: number, day: number): Date {
  const utcGuess = Date.UTC(year, month - 1, day);
  const firstOffset = londonOffsetMinutes(new Date(utcGuess));
  const firstCandidate = utcGuess - firstOffset * 60_000;
  const correctedOffset = londonOffsetMinutes(new Date(firstCandidate));
  return new Date(utcGuess - correctedOffset * 60_000);
}

export type TaskDeadlineState = {
  deadlineClosed: boolean;
  deadlineClosesAt: string | null;
  lateEditingAllowed: boolean;
};

export function getTaskDeadlineState(
  dueDate: string | null | undefined,
  lateEditingAllowed: boolean | null | undefined,
  now = new Date(),
): TaskDeadlineState {
  const parsed = typeof dueDate === "string" ? parseDateOnly(dueDate) : null;
  const reopened = Boolean(lateEditingAllowed);
  if (!parsed) {
    return { deadlineClosed: false, deadlineClosesAt: null, lateEditingAllowed: reopened };
  }

  const nextDay = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1));
  const closesAt = londonMidnightUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
  );
  return {
    deadlineClosed: !reopened && now.getTime() >= closesAt.getTime(),
    deadlineClosesAt: closesAt.toISOString(),
    lateEditingAllowed: reopened,
  };
}

export function withTaskDeadlineState<T extends {
  dueDate?: string | null;
  lateEditingAllowed?: boolean | null;
}>(task: T): T & TaskDeadlineState {
  return {
    ...task,
    ...getTaskDeadlineState(task.dueDate, task.lateEditingAllowed),
  };
}

export const TASK_DEADLINE_CLOSED_MESSAGE =
  "This task is closed because its due date has passed. You can still view your work, but editing and AI tools are no longer available. Ask your teacher if you need the task reopened.";