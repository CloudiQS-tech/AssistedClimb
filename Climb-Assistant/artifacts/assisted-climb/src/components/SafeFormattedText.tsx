import { Fragment, type ReactNode } from "react";
import { isRichTextAnswer, sanitiseRichTextHtml } from "@/lib/final-answer-format";

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("__") && part.endsWith("__")) return <u key={index}>{part.slice(2, -2)}</u>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function SafeFormattedText({ value, className = "" }: { value: string; className?: string }) {
  if (isRichTextAnswer(value) && typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(sanitiseRichTextHtml(value), "text/html");
    const renderNode = (node: Node, key: string): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) return <Fragment key={key}>{node.textContent}</Fragment>;
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const element = node as HTMLElement;
      const children = Array.from(element.childNodes).map((child, index) => renderNode(child, `${key}-${index}`));
      if (element.tagName === "H1") return <h2 key={key} className="text-xl font-semibold">{children}</h2>;
      if (element.tagName === "H2") return <h3 key={key} className="text-lg font-semibold">{children}</h3>;
      if (element.tagName === "STRONG") return <strong key={key}>{children}</strong>;
      if (element.tagName === "EM") return <em key={key}>{children}</em>;
      if (element.tagName === "U") return <u key={key}>{children}</u>;
      if (element.tagName === "BR") return <br key={key} />;
      if (element.tagName === "LI") return <li key={key}>{children}</li>;
      if (element.tagName === "UL" || (element.tagName === "OL" && Array.from(element.children).some((child) => (child as HTMLElement).dataset.list === "bullet"))) {
        return <ul key={key} className="list-disc space-y-1 pl-6">{children}</ul>;
      }
      if (element.tagName === "OL") return <ol key={key} className="list-decimal space-y-1 pl-6">{children}</ol>;
      return <p key={key}>{children}</p>;
    };
    return <div className={`space-y-3 whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>
      {Array.from(parsed.body.childNodes).map((node, index) => renderNode(node, String(index)))}
    </div>;
  }
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const bullet = /^-\s+(.+)$/.exec(line);
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const match = ordered ? /^\d+\.\s+(.+)$/.exec(lines[index]) : /^-\s+(.+)$/.exec(lines[index]);
        if (!match) break;
        items.push(<li key={index}>{inline(match[1])}</li>);
        index += 1;
      }
      blocks.push(ordered
        ? <ol key={`ol-${index}`} className="list-decimal space-y-1 pl-6">{items}</ol>
        : <ul key={`ul-${index}`} className="list-disc space-y-1 pl-6">{items}</ul>);
      continue;
    }
    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(heading[1].length === 1
        ? <h2 key={index} className="text-xl font-semibold">{inline(heading[2])}</h2>
        : <h3 key={index} className="text-lg font-semibold">{inline(heading[2])}</h3>);
    } else if (line.trim()) {
      blocks.push(<p key={index}>{inline(line)}</p>);
    } else {
      blocks.push(<div key={index} className="h-2" aria-hidden="true" />);
    }
    index += 1;
  }
  return <div className={`space-y-3 whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}>{blocks}</div>;
}