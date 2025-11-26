import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from "p-limit";
import pdfPoppler from "pdf-poppler"; // The new library
import os from "os";

// Shared imports
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

// --------------------- PDF → IMAGE (REBUILT WITH POPPLER) ---------------------
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
        // pdf-poppler uses 'jpeg' instead of 'jpg'
        const safeFormat = format === "jpg" ? "jpeg" : format;
        const dpi = parseInt(req.body.dpi) || 150;

        // 2. Configure Poppler Options
        const opts = {
            format: safeFormat,
            out_dir: outputDir,
            out_prefix: "page", // Files will be named page-1.png, page-2.png
            page: null, // Convert ALL pages
            scale: dpi / 72 // Poppler uses scale factor (72 is default)
        };

        // 3. Execute Conversion (No Loop Needed! Poppler does it all)
        await pdfPoppler.convert(uploadedFilePath, opts);

        // 4. Read the generated files
        const files = await fs.promises.readdir(outputDir);
        
        // Filter only valid image files
        const imageFiles = files.filter(file => file.endsWith(`.${safeFormat}`));

        if (imageFiles.length === 0) {
            throw new Error("No images were generated. The PDF might be empty or corrupted.");
        }

        // 5. SORT FILES NUMERICALLY (Critical Step)
        // 'page-1.png', 'page-10.png', 'page-2.png' -> We need 1, 2, 10
        imageFiles.sort((a, b) => {
            const numA = parseInt(a.match(/-(\d+)\./)[1]);
            const numB = parseInt(b.match(/-(\d+)\./)[1]);
            return numA - numB;
        });

        // 6. Send Response
        if (imageFiles.length === 1) {
            // Single Page
            const filePath = path.join(outputDir, imageFiles[0]);
            const fileBuffer = await fs.promises.readFile(filePath);
            
            res.setHeader("Content-Type", `image/${safeFormat}`);
            res.setHeader("Content-Disposition", `attachment; filename="page1.${format}"`);
            res.send(fileBuffer);
        } else {
            // Multiple Pages (ZIP)
            const archive = archiver("zip", { zlib: { level: 1 } });
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="pages.zip"`);
            
            archive.pipe(res);

            for (const [index, fileName] of imageFiles.entries()) {
                const filePath = path.join(outputDir, fileName);
                const fileBuffer = await fs.promises.readFile(filePath);
                archive.append(fileBuffer, { name: `page_${index + 1}.${format}` });
            }
            
            await archive.finalize();
        }

    } catch (err) {
        console.error("Conversion Error:", err);
        res.status(500).json({ error: err.message });
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