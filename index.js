import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import { fromBuffer } from "pdf2pic";
import fs from "fs";
import pLimit from "p-limit";

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
      
      const limit = pLimit(6); 

      const tasks = req.files.map((file) => {
        return limit(async () => {
          let image, imageBuffer;

          if (file.mimetype.includes("png")) {
            // PNG optimization: Lower compression level (0 is fastest, 9 is highest compression)
            imageBuffer = await sharp(file.buffer).png({ compressionLevel: 3 }).toBuffer();
            image = await pdfDoc.embedPng(imageBuffer);
          } else {
            // JPEG optimization: Set quality to 80 (fastest processing for minimal visual loss)
            imageBuffer = await sharp(file.buffer).jpeg({ quality: 80 }).toBuffer();
            image = await pdfDoc.embedJpg(imageBuffer);
          }
          return image; // Return the embedded image object
        });
      });

      // 3. Run all tasks concurrently (up to the limit)
      const embeddedImages = await Promise.all(tasks);

      // 4. Sequentially add the pages (this is fast)
      for (const image of embeddedImages) {
        const dims = { width: image.width, height: image.height };
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
  }
);

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

      const outputDir = "/tmp/pdf_conversion_output";
      
      // Ensure directory exists
      if (!fs.existsSync(outputDir)){
          fs.mkdirSync(outputDir, { recursive: true });
      }

      const options = {
        density: dpi,
        format: format === "jpg" ? "jpeg" : format,
        width: 0,
        height: 0,
        saveFilename: "page",
        savePath: outputDirm,
        graphicsProcess: "gm"
      };

      const converter = fromBuffer(req.file.buffer, options);
      const pdfDoc = await PDFDocument.load(req.file.buffer);
      const pageCount = pdfDoc.getPageCount();

      // Use p-limit with a LOW limit (2-3) because Ghostscript is very CPU/RAM heavy
      const limit = pLimit(2); 

      // 1. Create array of page numbers (tasks)
      const pageIndices = Array.from({ length: pageCount }, (_, i) => i + 1);

      // 2. Map pages to limited conversion tasks
      const tasks = pageIndices.map((i) => {
        return limit(async () => {
            const result = await converter(i, { responseType: "base64" });
            if (!result.base64) {
               throw new Error(`Failed to convert page ${i}.`);
            }
            return result;
        });
      });

      // 3. Run limited concurrent tasks
      const results = await Promise.all(tasks);

      // Send images or ZIP
      if (results.length === 1) {
        const img = results[0];
        const base64Data = img.base64;
        res.setHeader("Content-Type", `image/${format}`);
        res.setHeader("Content-Disposition", `attachment; filename="page1.${format}"`);
        res.send(Buffer.from(base64Data, "base64"));
      } else {
        // 4. Performance Optimization: Lower zlib compression level to 1 (Fastest)
        const archive = archiver("zip", { zlib: { level: 1 } }); 
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${req.file.originalname}-pages.zip"`);
        archive.pipe(res);

        results.forEach((img, i) => {
          const base64Data = img.base64;
          archive.append(Buffer.from(base64Data, "base64"), { name: `page_${i + 1}.${format}` });
        });

        await archive.finalize();
      }

      // Cleanup
      try {
          fs.rmSync(outputDir, { recursive: true, force: true });
      } catch (e) { console.error("Cleanup error", e); }

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));