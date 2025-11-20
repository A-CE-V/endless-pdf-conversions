import { PDFName, PDFString } from "pdf-lib";

export async function addEndlessForgeMetadata(pdfDoc) {
  const producer = "Endless Forge PDF API";
  const customMessage = "Processed or generated using Endless Forge Website";

  const infoDictRef = pdfDoc.context.trailer.get(PDFName.of("Info"));
  let infoDict = infoDictRef ? pdfDoc.context.lookup(infoDictRef) : null;

  if (!infoDict) {
    infoDict = pdfDoc.context.obj({});
    pdfDoc.context.trailer.set(PDFName.of("Info"), infoDict);
  }

  infoDict.set(PDFName.of("Producer"), PDFString.of(producer));
  infoDict.set(PDFName.of("Creator"), PDFString.of("Endless Forge"));
  infoDict.set(PDFName.of("Comments"), PDFString.of(customMessage));

  pdfDoc.setProducer(producer);
  pdfDoc.setCreator("Endless Forge");
  pdfDoc.setTitle("Generated PDF");
}
