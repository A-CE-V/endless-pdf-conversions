import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import archiver from "archiver";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import pLimit from "p-limit";
import { fromBuffer } from "pdf2pic"; // Use fromBuffer
// Shared imports (Keep your existing imports)
import { addEndlessForgeMetadata } from "./utils/pdfMetadata.js";
import { verifyInternalKey } from "./shared/apiKeyMiddleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 1. SETUP DISK STORAGE TO SAVE RAM
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });
app.use(express.json());

// Helper to delete files
const cleanupFiles = (files) => {
    if (!files) return;
    const fileArray = Array.isArray(files) ? files : [files];
    fileArray.forEach(f => {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
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
    // We still need a temporary directory for pdf2pic's output files
    const outputDir = path.join(__dirname, "conversion_output_" + Date.now());
    
    // Declare pdfBuffer here to ensure it's available in finally
    let pdfBuffer;
    let filePath; // Store the path to clean up later

    try {
        if (!req.file) return res.status(400).json({ error: "Upload a PDF" });

        filePath = req.file.path; // Save path before reading
        
        // 1. READ FILE AND IMMEDIATELY CLEAN UP THE UPLOADED FILE
        pdfBuffer = fs.readFileSync(filePath);
        cleanupFiles(req.file); // <-- DELETE THE UPLOADED FILE NOW!

        const format = (req.body.format || "png").toLowerCase();
        const dpi = parseInt(req.body.dpi) || 150;

        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const options = {
            density: dpi,
            format: format === "jpg" ? "jpeg" : format,
            saveFilename: "page",
            savePath: outputDir,
            width: 0, height: 0,
            graphicsProcess: "gm"
        };

        // 2. Use fromBuffer with the buffer we already read
        const converter = fromBuffer(pdfBuffer, options); 
        
        // Use the buffer to get the page count
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pageCount = pdfDoc.getPageCount();
        
        // ... (rest of the logic remains the same) ...

        const limit = pLimit(2); 
        const pageIndices = Array.from({ length: pageCount }, (_, i) => i + 1);

        const tasks = pageIndices.map((i) => {
            return limit(async () => {
                // responseType: "base64" is required when using fromBuffer
                const result = await converter(i, { responseType: "base64" }); 
                if (!result.base64) throw new Error(`Failed page ${i}`);
                return result;
            });
        });

        const results = await Promise.all(tasks);

        // ... (Send images or ZIP logic) ...
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
        console.error(err);
        // If the error happens before cleanupFiles(req.file) is called, 
        // we clean up the file here just in case.
        if (filePath) cleanupFiles({ path: filePath }); 
        res.status(500).json({ error: err.message });
    } finally {
        // CLEANUP: Only need to delete the output directory now
        try {
            if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
            // cleanupFiles(req.file) is no longer here, preventing the ENOENT error.
        } catch (e) { console.error("Output cleanup error", e); }
    }
});

app.get("/health", (req, res) => res.send({ status: "OK", service: "Image-API" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Image API running on port ${PORT}`));