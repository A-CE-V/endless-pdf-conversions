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
    // 1. Setup Output Directory
    const requestOutputId = "conversion_" + Date.now();
    const outputDir = path.join(TEMP_DIR, requestOutputId);
    
    let uploadedFilePath = null;

    try {
        if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

        uploadedFilePath = req.file.path;
        
        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const format = (req.body.format || "png").toLowerCase();
        // pdf-to-img uses 'jpg' instead of 'jpeg' for consistency
        const safeFormat = format === "jpeg" ? "jpg" : format;
        const dpi = parseInt(req.body.dpi) || 150;

        // 2. Configure pdf-to-img
        const converter = pdf(uploadedFilePath).toImage({
            quality: dpi,
            type: safeFormat,     // IMPORTANT: "type", not "format"
            outputDir,
            outputName: "page"
        });

        
        console.log(`Starting conversion using pdf-to-img at ${dpi} DPI...`);

        // 3. Execute Conversion using the asynchronous generator
        // This loop ensures the conversion processes every page.
        // NOTE: pdf-to-img does not have a built-in timeout like execPromise did.
        for await (const data of converter) {
            // Data is the path to the generated image; we just need the loop to run.
        }

        // 4. Read the generated files
        const files = await fs.promises.readdir(outputDir);
        
        // Filter only valid image files
        const imageFiles = files.filter(file => file.endsWith(`.${safeFormat}`));

        if (imageFiles.length === 0) {
            throw new Error(`pdf-to-img failed to generate ${safeFormat} images. Check logs for Poppler errors.`);
        }

        // 5. SORT FILES NUMERICALLY 
        imageFiles.sort((a, b) => {
            // Extracts the number part, e.g., 'page-1.png' -> 1
            const numA = parseInt(a.match(/page-(\d+)\./)[1]);
            const numB = parseInt(b.match(/page-(\d+)\./)[1]);
            return numA - numB;
        });

        // 6. Send Response (ZIP logic is the same)
        // Note: We use the *original* requested format name in the filename header
        const outputFilenameFormat = format === "jpeg" ? "jpg" : format;

        if (imageFiles.length === 1) {
            const filePath = path.join(outputDir, imageFiles[0]);
            const fileBuffer = await fs.promises.readFile(filePath);
            
            res.setHeader("Content-Type", `image/${safeFormat}`);
            res.setHeader("Content-Disposition", `attachment; filename="page1.${outputFilenameFormat}"`);
            res.send(fileBuffer);
        } else {
            const archive = archiver("zip", { zlib: { level: 1 } });
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="pages.zip"`);
            
            archive.pipe(res);

            for (const [index, fileName] of imageFiles.entries()) {
                const filePath = path.join(outputDir, fileName);
                const fileBuffer = await fs.promises.readFile(filePath);
                archive.append(fileBuffer, { name: `page_${index + 1}.${outputFilenameFormat}` });
            }
            
            await archive.finalize();
        }

    } catch (err) {
        console.error("PDF to Image Conversion Error (pdf-to-img):", err.message);
        res.status(500).json({ 
            error: "Conversion failed. Check logs for details.", 
            details: err.message 
        });
    } finally {
        // CLEANUP
        try {
            if (uploadedFilePath) cleanupFiles(uploadedFilePath);
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
        } catch (e) { console.error("Final cleanup error", e); }
    }
});

app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));