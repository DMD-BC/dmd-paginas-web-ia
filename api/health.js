// GET /api/health — Estado del backend de IA (sin exponer la llave).
const { PRIMARY_MODEL } = require('./_groq');

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido, usa GET' });
  }
  return res.status(200).json({
    status: 'ok',
    model: PRIMARY_MODEL,
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    timestamp: new Date().toISOString()
  });
};
