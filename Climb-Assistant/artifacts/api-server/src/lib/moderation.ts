import { Filter } from "bad-words";

const filter = new Filter();

export interface ModerationResult {
  blocked: boolean;
  reason?: string;
}

export function moderateStudentMessage(message: string): ModerationResult {
  try {
    if (filter.isProfane(message)) {
      return {
        blocked: true,
        reason: "Your message contains language that isn't appropriate for class. Please rephrase it.",
      };
    }
  } catch {
    // bad-words throws on certain edge cases — fail open (don't block)
  }

  return { blocked: false };
}
