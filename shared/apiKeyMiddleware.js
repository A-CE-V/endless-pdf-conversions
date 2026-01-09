import crypto from 'crypto';

const INTERNAL_SECRET = process.env.INTERNAL_API_KEY; 

export function verifyInternalKey(req, res, next) {
  try {
    const signature = req.headers['x-auth-signature'];
    const timestamp = req.headers['x-auth-timestamp'];

    if (!signature || !timestamp) return res.status(401).json({ error: "Missing auth headers" });

    // 1. Replay Attack Check
    const now = Date.now();
    if (Math.abs(now - parseInt(timestamp, 10)) > 60000) {
      return res.status(401).json({ error: "Request expired" });
    }

    // 2. Reconstruct the Signature
    // We update HMAC with timestamp, then the rawBody we captured in index.js
    const hmac = crypto.createHmac('sha256', INTERNAL_SECRET);
    hmac.update(timestamp);
    
    if (req.rawBody && req.rawBody.length > 0) {
      hmac.update(req.rawBody);
    }

    const calculatedSignature = hmac.digest('hex');

    // 3. Compare
    if (signature !== calculatedSignature) {
      // DEBUG LOG: This will show up in your Render logs
      console.log(`SIG FAIL: Received ${signature.substring(0,6)}... vs Calculated ${calculatedSignature.substring(0,6)}...`);
      console.log(`Secret length: ${INTERNAL_SECRET.length}`); 
      return res.status(401).json({ error: "Invalid Signature" });
    }

    next();
  } catch (err) {
    console.error("Auth Error", err);
    res.status(401).json({ error: "Authentication failed" });
  }
}