export const SUPPORTING_MATERIAL_TYPES = [
  "Document",
  "Image",
  "Presentation",
  "Spreadsheet",
  "Other",
] as const;

export const SUPPORTING_MATERIAL_MAX_CHARACTERS = 10_000;

export type SupportingMaterialType = (typeof SUPPORTING_MATERIAL_TYPES)[number];

export type SupportingMaterialCard = {
  name: string;
  type: SupportingMaterialType | "";
  whatItShows: string;
  whyRelevant: string;
  finalResponseReference: string;
  sharingMethod: string;
};

export const SUPPORTING_MATERIAL_TEXT_FIELDS = [
  "name",
  "whatItShows",
  "whyRelevant",
  "finalResponseReference",
  "sharingMethod",
] as const;

export function emptySupportingMaterial(): SupportingMaterialCard {
  return {
    name: "",
    type: "",
    whatItShows: "",
    whyRelevant: "",
    finalResponseReference: "",
    sharingMethod: "",
  };
}

export function normaliseSupportingMaterialCards(value: unknown): SupportingMaterialCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const card = item as Record<string, unknown>;
    const type: SupportingMaterialCard["type"] = typeof card.type === "string" && SUPPORTING_MATERIAL_TYPES.includes(card.type as SupportingMaterialType)
      ? card.type as SupportingMaterialType
      : "";
    const normalisedCard: SupportingMaterialCard = {
      name: typeof card.name === "string" ? card.name : "",
      type,
      whatItShows: typeof card.whatItShows === "string" ? card.whatItShows : "",
      whyRelevant: typeof card.whyRelevant === "string" ? card.whyRelevant : "",
      finalResponseReference: typeof card.finalResponseReference === "string" ? card.finalResponseReference : "",
      sharingMethod: typeof card.sharingMethod === "string" ? card.sharingMethod : "",
    };
    return isSupportingMaterialCardEmpty(normalisedCard) ? [] : [normalisedCard];
  });
}

export function isSupportingMaterialCardEmpty(card: SupportingMaterialCard): boolean {
  return card.type === "" && SUPPORTING_MATERIAL_TEXT_FIELDS.every((field) => card[field].trim() === "");
}

export function supportingMaterialCardsForPersistence(cards: SupportingMaterialCard[]): SupportingMaterialCard[] {
  return cards.filter((card) => !isSupportingMaterialCardEmpty(card));
}

export function supportingMaterialTextLength(card: SupportingMaterialCard): number {
  return SUPPORTING_MATERIAL_TEXT_FIELDS.reduce((total, field) => total + card[field].length, 0);
}

export function supportingMaterialCardsTextLength(cards: SupportingMaterialCard[]): number {
  return cards.reduce((total, card) => total + supportingMaterialTextLength(card), 0);
}