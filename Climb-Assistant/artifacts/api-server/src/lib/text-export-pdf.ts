import PDFDocument from "pdfkit";

type TextExportPdfInput = {
  title: string;
  text: string;
};

const MAX_TITLE_LENGTH = 160;
const MAX_TEXT_LENGTH = 90_000;

export function renderTextExportPdf(input: TextExportPdfInput): Promise<Buffer> {
  const title = input.title.trim().slice(0, MAX_TITLE_LENGTH) || "Assisted Climb export";
  const text = input.text.trim().slice(0, MAX_TEXT_LENGTH) || "No recorded content.";

  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: title,
        Author: "The Assisted Climb",
      },
    });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));

    document
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#111827")
      .text(title);
    document.moveDown(1);
    document
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#111827")
      .text(text, {
        lineGap: 3,
        paragraphGap: 8,
        continued: false,
      });
    document.end();
  });
}