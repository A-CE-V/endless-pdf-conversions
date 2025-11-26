import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from "p-limit";
import { fromPath } from "pdf2pic"; // Revert to fromPath (it is more stable)

// Shared imports
import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyInternalKey } from "./shared/apiKeyMiddleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 1. USE SYSTEM TEMP DIRECTORY FOR UPLOADS (Better for Docker)
// On Linux/Docker, os.tmpdir() is usually '/tmp'
import os from "os";
const TEMP_DIR = os.tmpdir();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TEMP_DIR);
  },
  filename: function (req, file, cb) {
    // Simple safe filename
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
app.post("/pdf/image-to-pdf", verifyInternalKey, upload.array("images"), async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Upload images" });

      const pdfDoc = await PDFDocument.create();
      const limit = pLimit(5); // Reduced concurrency for stability

      const tasks = req.files.map((file) => {
        return limit(async () => {
          // Read from disk explicitly only when needed
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
      
      // Cleanup uploaded images
      cleanupFiles(req.files);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="images.pdf"`);
      res.send(Buffer.from(pdfBytes));

    } catch (err) {
      cleanupFiles(req.files); // Ensure cleanup on error
      console.error(err);
      res.status(500).json({ error: err.message });
    }
});

// --------------------- PDF → IMAGE ---------------------
app.post("/pdf/pdf-to-image", verifyInternalKey, upload.single("pdf"), async (req, res) => {
    // Create a unique subfolder in /tmp for this request's outputs
    const requestOutputId = "conversion_" + Date.now();
    const outputDir = path.join(TEMP_DIR, requestOutputId);
    
    let uploadedFilePath = null;

    try {
        if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

        uploadedFilePath = req.file.path; // This is now in /tmp/upload-....pdf

        const format = (req.body.format || "png").toLowerCase();
        const dpi = parseInt(req.body.dpi) || 150;

        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const options = {
            density: dpi,
            format: format === "jpg" ? "jpeg" : format,
            saveFilename: "page",
            savePath: outputDir,
            width: 0, height: 0,
            graphicsProcess: "gm"
        };

        // 1. Initialize converter pointing to the file on disk
        const converter = fromPath(uploadedFilePath, options);
        
        // 2. Load PDF to get page count
        // Note: loading from disk is memory efficient
        const pdfBuffer = fs.readFileSync(uploadedFilePath);
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pageCount = pdfDoc.getPageCount();

        // 3. CRITICAL: Set Limit to 1 for Free Tier
        // Rendering PDF to Image is heavy. Doing 2 at once might kill the 512MB RAM.
        const limit = pLimit(1); 
        
        const pageIndices = Array.from({ length: pageCount }, (_, i) => i + 1);

        const tasks = pageIndices.map((i) => {
            return limit(async () => {
                // Return base64 so we don't have to read the file back from disk manually
                const result = await converter(i, { responseType: "base64" });
                
                // Detailed error checking
                if (!result || !result.base64) {
                    console.error(`Page ${i} failed. Result:`, result);
                    throw new Error(`Failed to convert page ${i}`);
                }
                return result;
            });
        });

        const results = await Promise.all(tasks);

        // ... Response Logic ...
        if (results.length === 1) {
            const base64Data = results[0].base64;
            res.setHeader("Content-Type", `image/${format}`);
            res.setHeader("Content-Disposition", `attachment; filename="page1.${format}"`);
            res.send(Buffer.from(base64Data, "base64"));
        } else {
            const archive = archiver("zip", { zlib: { level: 1 } });
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="pages.zip"`);
            archive.pipe(res);

            results.forEach((img, i) => {
              archive.append(Buffer.from(img.base64, "base64"), { name: `page_${i + 1}.${format}` });
            });
            await archive.finalize();
        }

    } catch (err) {
        console.error("Conversion Error:", err);
        res.status(500).json({ error: err.message });
    } finally {
        // CLEANUP
        try {
            // Delete the uploaded PDF
            if (uploadedFilePath) cleanupFiles(uploadedFilePath);
            
            // Delete the output folder and its contents
            if (fs.existsSync(outputDir)) {
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
        } catch (e) { console.error("Final cleanup error", e); }
    }
});

app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));