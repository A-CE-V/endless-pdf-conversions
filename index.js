import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from "p-limit";
import os from "os";
import {pdf} from "pdf-to-img";
import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyInternalKey } from "./shared/apiKeyMiddleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// USE SYSTEM TEMP DIRECTORY
const TEMP_DIR = os.tmpdir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TEMP_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'upload-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });
app.use(express.json());

// Helper to delete files safely
const cleanupFiles = (paths) => {
    if (!paths) return;
    const pathArray = Array.isArray(paths) ? paths : [paths];
    pathArray.forEach(p => {
        try {
            if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) { console.error("Cleanup warning:", e.message); }
    });
};

// --------------------- IMAGE → PDF ---------------------
// (Your existing code for Image to PDF remains exactly the same)
app.post("/pdf/image-to-pdf", verifyInternalKey, upload.array("images"), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Upload images" });

      const pdfDoc = await PDFDocument.create();
      const limit = pLimit(5);

      const tasks = req.files.map((file) => {
        return limit(async () => {
          const fileBuffer = await fs.promises.readFile(file.path);
          let imageBuffer;
          if (file.mimetype.includes("png")) {
            imageBuffer = await sharp(fileBuffer).png({ compressionLevel: 3 }).toBuffer();
            return pdfDoc.embedPng(imageBuffer);
          } else {
            imageBuffer = await sharp(fileBuffer).jpeg({ quality: 80 }).toBuffer();
            return pdfDoc.embedJpg(imageBuffer);
          }
        });
      });

      const embeddedImages = await Promise.all(tasks);

      for (const image of embeddedImages) {
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }

      await addEndlessForgeMetadata(pdfDoc);
      const pdfBytes = await pdfDoc.save();
      
      cleanupFiles(req.files.map(f => f.path));

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="images.pdf"`);
      res.send(Buffer.from(pdfBytes));

    } catch (err) {
      if(req.files) cleanupFiles(req.files.map(f => f.path));
      console.error(err);
      res.status(500).json({ error: err.message });
    }
});

// --------------------- PDF → IMAGE (Rewritten with pdf-to-img) ---------------------
app.post("/pdf/pdf-to-image", verifyInternalKey, upload.single("pdf"), async (req, res) => {
    const requestOutputId = "conversion_" + Date.now();
    const outputDir = path.join(TEMP_DIR, requestOutputId);

    let uploadedFilePath = null;

    try {
        if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

        uploadedFilePath = req.file.path;
        
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const format = (req.body.format || "png").toLowerCase();
        const safeFormat = format === "jpeg" ? "jpg" : format;

        const dpi = parseInt(req.body.dpi) || 2; 
        // pdf-to-img uses "scale" not DPI, so use scale instead
        const scale = dpi / 72; // approx conversion

        console.log(`Converting PDF using pdf-to-img...`);

        // REAL API
        const doc = await pdf(uploadedFilePath, { scale });

        const imageFiles = [];
        let pageNum = 1;

        // Convert each page
        for await (const buffer of doc) {
            const filename = `page-${pageNum}.${safeFormat}`;
            const filepath = path.join(outputDir, filename);

            // Convert PNG buffer to JPG if requested
            let outBuffer = buffer;

            if (safeFormat === "jpg") {
                outBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
            }

            await fs.promises.writeFile(filepath, outBuffer);

            imageFiles.push(filename);
            pageNum++;
        }

        if (imageFiles.length === 0) {
            throw new Error(`pdf-to-img failed to generate images`);
        }

        // Send results

        if (imageFiles.length === 1) {
            const filePath = path.join(outputDir, imageFiles[0]);
            const fileBuffer = await fs.promises.readFile(filePath);

            res.setHeader("Content-Type", `image/${safeFormat}`);
            res.setHeader("Content-Disposition", `attachment; filename="page1.${safeFormat}"`);
            return res.send(fileBuffer);
        }

        // MULTIPLE PAGES -> ZIP
        const archive = archiver("zip", { zlib: { level: 1 } });

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="pages.zip"`);

        archive.pipe(res);

        for (const fileName of imageFiles) {
            const filePath = path.join(outputDir, fileName);
            archive.file(filePath, { name: fileName });
        }

        await archive.finalize();

    } catch (err) {
        console.error("PDF to Image Conversion Error:", err);
        res.status(500).json({
            error: "Conversion failed. Check logs for details.",
            details: err.message
        });

    } finally {
        try {
            if (uploadedFilePath) cleanupFiles(uploadedFilePath);
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.error("Final cleanup error", e);
        }
    }
});


app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));