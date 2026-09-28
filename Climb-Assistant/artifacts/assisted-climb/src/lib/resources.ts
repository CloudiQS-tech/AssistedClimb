export const RESOURCE_TYPES = ["Web link", "Book", "Video", "Document", "Other"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function parseResource(value: string): { type: ResourceType; label: string } {
  const match = value.match(/^\[([^\]]+)\]\s*(.*)$/);
  const type = match?.[1] && RESOURCE_TYPES.includes(match[1] as ResourceType)
    ? match[1] as ResourceType
    : value.trim().startsWith("http")
      ? "Web link"
      : "Other";
  return { type, label: match?.[2] ?? value };
}

export function formatResource(type: ResourceType, label: string): string {
  const trimmed = label.trim();
  return trimmed ? `[${type}] ${trimmed}` : `[${type}]`;
}

export function hasResourceLabel(value: string): boolean {
  return parseResource(value).label.trim().length > 0;
}