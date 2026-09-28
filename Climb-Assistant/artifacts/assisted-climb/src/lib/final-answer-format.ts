const RICH_TEXT_PATTERN = /^\s*<(?:p|h1|h2|ol|ul|li|strong|em|u|br)\b/i;

export function isRichTextAnswer(value: string): boolean {
  return RICH_TEXT_PATTERN.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownInlineToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function answerStorageToEditorHtml(value: string): string {
  if (!value.trim()) return "";
  if (isRichTextAnswer(value)) return sanitiseRichTextHtml(value);
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const heading = /^(#{1,2})\s+(.+)$/.exec(lines[index]);
    if (heading) {
      blocks.push(`<h${heading[1].length}>${markdownInlineToHtml(heading[2])}</h${heading[1].length}>`);
      index += 1;
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(lines[index]);
    const numbered = /^\d+\.\s+(.+)$/.exec(lines[index]);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (index < lines.length) {
        const match = ordered ? /^\d+\.\s+(.+)$/.exec(lines[index]) : /^-\s+(.+)$/.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${markdownInlineToHtml(match[1])}</li>`);
        index += 1;
      }
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    blocks.push(lines[index].trim() ? `<p>${markdownInlineToHtml(lines[index])}</p>` : "<p><br></p>");
    index += 1;
  }
  return blocks.join("");
}

export function sanitiseRichTextHtml(value: string): string {
  if (typeof DOMParser === "undefined") return value;
  const parsed = new DOMParser().parseFromString(value, "text/html");
  const allowed = new Set(["P", "BR", "H1", "H2", "STRONG", "EM", "U", "OL", "UL", "LI"]);
  const clean = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    if (["SCRIPT", "STYLE", "IMG", "SVG", "IFRAME", "OBJECT", "EMBED"].includes(element.tagName)) return "";
    const children = Array.from(element.childNodes).map(clean).join("");
    if (!allowed.has(element.tagName)) return children;
    if (element.tagName === "BR") return "<br>";
    const tag = element.tagName.toLowerCase();
    const listAttribute = element.tagName === "LI" && ["bullet", "ordered"].includes(element.dataset.list ?? "")
      ? ` data-list="${element.dataset.list}"`
      : "";
    return `<${tag}${listAttribute}>${children}</${tag}>`;
  };
  return Array.from(parsed.body.childNodes).map(clean).join("");
}

export function answerVisibleText(value: string): string {
  if (!value.trim()) return "";
  if (isRichTextAnswer(value) && typeof DOMParser !== "undefined") {
    return (new DOMParser().parseFromString(sanitiseRichTextHtml(value), "text/html").body.textContent ?? "").replace(/\u00a0/g, " ");
  }
  return value
    .replace(/^#{1,2}\s+/gm, "")
    .replace(/^\s*(?:-\s+|\d+\.\s+)/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

export function answerReadableText(value: string): string {
  if (!isRichTextAnswer(value) || typeof DOMParser === "undefined") return answerVisibleText(value);
  const parsed = new DOMParser().parseFromString(sanitiseRichTextHtml(value), "text/html");
  const lines: string[] = [];
  const walk = (element: Element) => {
    if (element.tagName === "H1" || element.tagName === "H2" || element.tagName === "P") {
      lines.push((element.textContent ?? "").trim());
      return;
    }
    if (element.tagName === "LI") {
      const siblings = Array.from(element.parentElement?.children ?? []);
      const prefix = (element as HTMLElement).dataset.list === "ordered" || element.parentElement?.tagName === "OL"
        ? `${siblings.indexOf(element) + 1}. `
        : "- ";
      lines.push(`${prefix}${(element.textContent ?? "").trim()}`);
      return;
    }
    Array.from(element.children).forEach(walk);
  };
  Array.from(parsed.body.children).forEach(walk);
  return lines.join("\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}