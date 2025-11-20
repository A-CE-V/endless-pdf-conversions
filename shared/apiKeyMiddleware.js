export async function verifyInternalKey(req, res, next) {
  const key = req.header("X-Internal-Auth");
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
