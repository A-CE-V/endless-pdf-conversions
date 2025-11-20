// index.js (Image Service)
import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import { fromBuffer } from "pdf2pic";

// Shared imports
import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyInternalKey } from "./shared/apiKeyMiddleware.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// --------------------- IMAGE → PDF ---------------------
app.post(
  "/pdf/image-to-pdf",
  verifyInternalKey,
  upload.array("images"),
  async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "Upload images" });

    const pdfDoc = await PDFDocument.create();

    for (const file of req.files) {
      let image, dims;

      if (file.mimetype.includes("png")) {
        const pngBuffer = await sharp(file.buffer).png().toBuffer();
        image = await pdfDoc.embedPng(pngBuffer);
        dims = { width: image.width, height: image.height };
      } else {
        const jpegBuffer = await sharp(file.buffer).jpeg().toBuffer();
        image = await pdfDoc.embedJpg(jpegBuffer);
        dims = { width: image.width, height: image.height };
      }

      const page = pdfDoc.addPage([dims.width, dims.height]);
      page.drawImage(image, { x: 0, y: 0, width: dims.width, height: dims.height });
    }
    await addEndlessForgeMetadata(pdfDoc);
    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="images.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------- PDF → IMAGE ---------------------
app.post(
  "/pdf/pdf-to-image",
  verifyInternalKey,
  upload.single("pdf"),
  async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

    const format = (req.body.format || "png").toLowerCase();
    const dpi = parseInt(req.body.dpi) || 150;

    const options = {
      density: dpi,
      format: format === "jpg" ? "jpeg" : format,
      width: 0,
      height: 0,
      saveFilename: "page",
      savePath: "./output" // safer path for Windows
    };

    // Load the converter
    const converter = fromBuffer(req.file.buffer, options);

    // Get number of pages
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pageCount = pdfDoc.getPageCount();
    const results = [];

    // Generate images
    for (let i = 1; i <= pageCount; i++) {
      const result = await converter(i, { responseType: "base64" });
      results.push(result);
    }

    // Send images or ZIP
    if (results.length === 1) {
      const img = results[0];
      const base64Data = img.base64;
      res.setHeader("Content-Type", `image/${format}`);
      res.setHeader("Content-Disposition", `attachment; filename="page1.${format}"`);
      res.send(Buffer.from(base64Data, "base64"));
    } else {
      const archive = archiver("zip", { zlib: { level: 9 } });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${req.file.originalname}-pages.zip"`);
      archive.pipe(res);

      results.forEach((img, i) => {
        const base64Data = img.base64;
        archive.append(Buffer.from(base64Data, "base64"), { name: `page_${i + 1}.${format}` });
      });

      await archive.finalize();
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));