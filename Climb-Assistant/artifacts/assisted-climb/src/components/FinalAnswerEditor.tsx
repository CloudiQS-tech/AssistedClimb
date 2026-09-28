import { useRef } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import { answerStorageToEditorHtml, sanitiseRichTextHtml } from "@/lib/final-answer-format";

type Format = "bold" | "italic" | "underline";
type BlockFormat = "heading" | "subheading" | "bullet" | "ordered";

export function FinalAnswerEditor({
  value,
  onChange,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  const editorRef = useRef<ReactQuill>(null);
  const editorValue = answerStorageToEditorHtml(value);

  const inline = (format: Format) => {
    const editor = editorRef.current?.getEditor();
    if (!editor || readOnly) return;
    const range = editor.getSelection(true);
    if (!range || range.length === 0) return;
    const active = Boolean(editor.getFormat(range)[format]);
    editor.format(format, !active, "user");
    editor.focus();
  };

  const block = (format: BlockFormat) => {
    const editor = editorRef.current?.getEditor();
    if (!editor || readOnly) return;
    const range = editor.getSelection(true);
    if (!range || range.length === 0) return;
    const length = range.length;
    if (format === "heading") editor.formatLine(range.index, length, { header: 1, list: false }, "user");
    if (format === "subheading") editor.formatLine(range.index, length, { header: 2, list: false }, "user");
    if (format === "bullet") editor.formatLine(range.index, length, { header: false, list: "bullet" }, "user");
    if (format === "ordered") editor.formatLine(range.index, length, { header: false, list: "ordered" }, "user");
    editor.focus();
  };

  const pasteRestrictedHtml = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const html = event.clipboardData.getData("text/html");
    const editor = editorRef.current?.getEditor();
    if (!html || !editor || readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const range = editor.getSelection(true);
    editor.deleteText(range.index, range.length, "user");
    editor.clipboard.dangerouslyPasteHTML(range.index, sanitiseRichTextHtml(html), "user");
    editor.focus();
  };

  return (
    <div className="space-y-3" onPasteCapture={pasteRestrictedHtml}>
      <p className="text-sm text-neutral-600">Write your answer below. Highlight text and use the buttons to format it.</p>
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Final Answer formatting">
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => block("heading")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Heading</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => block("subheading")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Subheading</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => inline("bold")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-bold disabled:opacity-50">Bold</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => inline("italic")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold italic disabled:opacity-50">Italic</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => inline("underline")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold underline disabled:opacity-50">Underline</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => block("bullet")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Bullets</button>
        <button type="button" disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => block("ordered")} className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Numbered list</button>
      </div>
      <ReactQuill
        ref={editorRef}
        theme="snow"
        value={editorValue}
        readOnly={readOnly}
        formats={["header", "bold", "italic", "underline", "list"]}
        modules={{ toolbar: false }}
        onChange={(html, _delta, source) => {
          if (source === "user") onChange(sanitiseRichTextHtml(html));
        }}
        className="final-answer-editor"
      />
    </div>
  );
}