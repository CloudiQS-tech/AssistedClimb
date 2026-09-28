const RICH_TEXT_PATTERN = /^\s*<(?:p|h1|h2|ol|ul|li|strong|em|u|br)\b/i;

export function isRichTextAnswer(value: string): boolean {
  return RICH_TEXT_PATTERN.test(value);
}

export function sanitiseFinalAnswerHtml(value: string): string {
  if (!isRichTextAnswer(value)) return value;
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(img|input|video|audio|source|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "<br>")
    .replace(/<\s*\/?\s*(p|h1|h2|strong|em|u|ol|ul)\b[^>]*>/gi, (tag, name: string) =>
      tag.includes("/") ? `</${name.toLowerCase()}>` : `<${name.toLowerCase()}>`)
    .replace(/<\s*li\b([^>]*)>/gi, (_tag, attributes: string) => {
      const list = /\bdata-list\s*=\s*["']?(bullet|ordered)["']?/i.exec(attributes)?.[1]?.toLowerCase();
      return list ? `<li data-list="${list}">` : "<li>";
    })
    .replace(/<\s*\/\s*li\s*>/gi, "</li>")
    .replace(/<(?!\/?(?:p|h1|h2|strong|em|u|ol|ul|li|br)(?:\s|>|\/))[^>]*>/gi, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

export function finalAnswerReadableText(value: string): string {
  if (!isRichTextAnswer(value)) {
    return value
      .replace(/^#{1,2}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1");
  }
  let orderedIndex = 0;
  const clean = sanitiseFinalAnswerHtml(value)
    .replace(/<h[12]>/gi, "\n").replace(/<\/h[12]>/gi, "\n")
    .replace(/<p>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<br>/gi, "\n")
    .replace(/<ol>/gi, () => { orderedIndex = 0; return "\n"; })
    .replace(/<ul>/gi, "\n")
    .replace(/<li(?:\s+data-list="(bullet|ordered)")?>/gi, (_tag, list: string | undefined) => {
      const ordered = list === "ordered";
      if (ordered) orderedIndex += 1;
      return `\n${ordered ? `${orderedIndex}. ` : "- "}`;
    })
    .replace(/<\/(?:ol|ul|li)>/gi, "\n")
    .replace(/<\/?(?:strong|em|u)>/gi, "")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(clean).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}