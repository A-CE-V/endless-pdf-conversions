import { PDFName, PDFString } from "pdf-lib";

export async function addEndlessForgeMetadata(pdfDoc) {
  const producer = "Endless Forge PDF API";
  const customMessage = "Processed or generated using Endless Forge Website";

  const trailer = pdfDoc.context.trailer;
  
  if (!trailer || typeof trailer.get !== 'function') {
      console.warn("pdfDoc.context.trailer is missing or invalid. Skipping internal metadata dictionary setup.");
      
  } else {
      let infoDict = infoDictRef ? pdfDoc.context.lookup(infoDictRef) : null;

      if (!infoDict) {
        infoDict = pdfDoc.context.obj({});
        trailer.set(PDFName.of("Info"), infoDict);
      }

      infoDict.set(PDFName.of("Producer"), PDFString.of(producer));
      infoDict.set(PDFName.of("Creator"), PDFString.of("Endless Forge"));
      infoDict.set(PDFName.of("Comments"), PDFString.of(customMessage));
  }
  
  pdfDoc.setProducer(producer);
  pdfDoc.setCreator("Endless Forge");
  pdfDoc.setTitle("Generated PDF");
}