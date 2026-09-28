import PDFDocument from "pdfkit";

type TeacherMessagePdfItem = {
  sender: string;
  createdAt: Date | string;
  content: string;
};

export function renderTeacherMessagesPdf(messages: TeacherMessagePdfItem[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margin: 50,
      info: { Title: "Student Messages" },
    });
    const chunks: Buffer[] = [];

    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    document.fontSize(18).font("Helvetica-Bold").text("Student Messages");
    document.moveDown(1);

    if (messages.length === 0) {
      document.fontSize(11).font("Helvetica").fillColor("#555555").text("None recorded");
    } else {
      messages.forEach((message, index) => {
        if (index > 0) document.moveDown(1);
        document.fontSize(11).font("Helvetica-Bold").fillColor("#111111").text(message.sender);
        document.fontSize(9).font("Helvetica").fillColor("#555555").text(new Date(message.createdAt).toISOString());
        document.moveDown(0.35);
        document.fontSize(11).font("Helvetica").fillColor("#111111").text(message.content, {
          lineGap: 3,
        });
      });
    }

    document.end();
  });
}