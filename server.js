import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import Razorpay from 'razorpay';
import QRCode from 'qrcode';
import Tesseract from 'tesseract.js';
import pdf from 'pdf-parse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname, { extensions: ['html'] }));

const supabaseReady = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_URL.includes('YOUR_PROJECT'));
const supabaseAdmin = supabaseReady ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
const supabasePublic = supabaseReady ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }) : null;
const razorpayReady = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = razorpayReady ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  const allowed = ['image/png','image/jpeg','image/webp','application/pdf','text/plain','text/csv'];
  cb(allowed.includes(file.mimetype) ? null : new Error('Unsupported file type. Use PDF, PNG, JPG, WEBP, TXT or CSV.'), allowed.includes(file.mimetype));
}});

const factors = {
  electricity: { unit: 'kWh', factor: 0.716, note: 'Illustrative grid electricity factor; replace with the factor appropriate to location/year.' },
  diesel: { unit: 'litres', factor: 2.68, note: 'Illustrative direct-combustion factor.' },
  petrol: { unit: 'litres', factor: 2.31, note: 'Illustrative direct-combustion factor.' },
  gas: { unit: 'standard m³', factor: 2.0, note: 'Illustrative factor; verify the gas composition and methodology.' }
};
const finitePositive = v => Number.isFinite(Number(v)) && Number(v) > 0;

const BILL_EMISSION_FACTORS = {
  electricity: {
    unit: 'kWh',
    factor: 0.716,
    note: 'Illustrative electricity factor; verify for location and reporting year.'
  },
  diesel: {
    unit: 'litres',
    factor: 2.68,
    note: 'Illustrative direct combustion factor.'
  },
  lpg: {
    unit: 'kg',
    factor: 2.98,
    note: 'Approximate direct combustion factor.'
  },
  png: {
    unit: 'standard m3',
    factor: 1.9,
    note: 'Approximate gas factor; verify methodology.'
  }
};

function extractUtilityBillData(text) {
  const input = String(text || '').replace(/\u00a0/g, ' ');

  const patterns = [
    {
      source: 'electricity',
      regex: /(?:units consumed|energy consumed|consumption|units|kwh)\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:kwh|units?)\b/i
    },
    {
      source: 'diesel',
      regex: /diesel(?: consumption| used| quantity)?\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:litres?|ltrs?|ltr)\b/i
    },
    {
      source: 'lpg',
      regex: /(?:lpg|liquefied petroleum gas)(?:\s+(?:consumption|quantity|used))?\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:kg|kilograms?)\b/i
    },
    {
      source: 'png',
      regex: /(?:png|piped natural gas|natural gas)(?:\s+(?:consumption|quantity|used))?\s*[:=-]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:standard\s*m(?:3|³)|scm|m(?:3|³))\b/i
    }
  ];

  const candidates = [];

  for (const item of patterns) {
    const match = input.match(item.regex);
    if (!match) continue;

    const quantity = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const info = BILL_EMISSION_FACTORS[item.source];

    candidates.push({
      source: item.source,
      quantity,
      unit: info.unit,
      emissionFactorKgCO2ePerUnit: info.factor,
      estimatedKgCO2e: Number((quantity * info.factor).toFixed(3)),
      factorNote: info.note,
      evidence: match[0],
      needsUserConfirmation: true
    });
  }

  return {
    candidates,
    estimatedTotalKgCO2e: Number(
      candidates.reduce((sum, item) => sum + item.estimatedKgCO2e, 0).toFixed(3)
    ),
    needsUserConfirmation: true,
    warning: candidates.length
      ? 'Estimates only. Confirm quantity, unit, billing period and emission factor before saving an audit.'
      : 'No clear supported consumption value found. Check the extracted text and enter the quantity manually.'
  };
}


app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ChainLedger AI API', features: { cloudDatabase: supabaseReady, aiAdvisor: Boolean(process.env.AI_API_KEY), payment: razorpayReady, documentOCR: true }, note: 'OCR is enabled for supported uploads. Emission factors are illustrative until configured for your reporting methodology.' }));

app.post('/api/carbon/calculate', (req, res) => {
  const { source, quantity, factor: customFactor } = req.body || {};
  if (!Object.hasOwn(factors, source)) return res.status(400).json({ error: 'Unsupported source. Use electricity, diesel, petrol or gas.' });
  if (!finitePositive(quantity)) return res.status(400).json({ error: 'Quantity must be a positive number.' });
  const factor = customFactor === undefined || customFactor === null || customFactor === '' ? factors[source].factor : Number(customFactor);
  if (!Number.isFinite(factor) || factor < 0 || factor > 1000000) return res.status(400).json({ error: 'Emission factor must be a valid non-negative number.' });
  res.json({ source, quantity: Number(quantity), unit: factors[source].unit, factor, kgCO2e: Number(quantity) * factor, factorNote: factors[source].note, status: 'estimate_not_verified' });
});

app.post('/api/scan', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a file using form field "file".' });
    let text = '';
    if (req.file.mimetype === 'application/pdf') {
      const parsed = await pdf(req.file.buffer);
      text = parsed.text || '';
      if (!text.trim()) return res.status(422).json({ error: 'This PDF appears to be scanned/image-only. Upload a clear image or use OCR-capable PDF processing.', extractedText: '' });
    } else if (req.file.mimetype.startsWith('image/')) {
      const result = await Tesseract.recognize(req.file.buffer, 'eng');
      text = result.data.text || '';
    } else {
      text = req.file.buffer.toString('utf8');
    }
    const numbers = [...text.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, ''))).filter(n => Number.isFinite(n));
    res.json({ fileName: req.file.originalname, mimeType: req.file.mimetype, extractedText: text.slice(0, 15000), candidateNumbers: numbers.slice(0, 30), needsUserConfirmation: true, warning: 'OCR/text extraction can be wrong. Verify the consumption value and unit before calculating emissions.' });
  } catch (err) { next(err); }
});

app.post('/api/advisor', async (req, res) => {
  const { audits = [], question = '' } = req.body || {};
  if (!Array.isArray(audits) || audits.length > 500) return res.status(400).json({ error: 'audits must be an array of up to 500 entries.' });
  const clean = audits.map(a => ({ name: String(a.name || 'Audit').slice(0,100), source: String(a.source || a.label || 'unknown').slice(0,60), quantity: Number(a.quantity) || 0, unit: String(a.unit || '').slice(0,30), kgCO2e: Number(a.kg ?? a.kgCO2e) || 0 })).filter(a => a.quantity >= 0 && a.kgCO2e >= 0);
  const total = clean.reduce((s, a) => s + a.kgCO2e, 0);
  const bySource = Object.entries(clean.reduce((o,a) => { o[a.source] = (o[a.source] || 0) + a.kgCO2e; return o; }, {})).sort((a,b) => b[1]-a[1]);
  if (!process.env.AI_API_KEY) {
    const top = bySource[0];
    return res.json({ mode: 'rule_based', totalKgCO2e: total, advice: [top ? `Review ${top[0]} first; it contributes the largest share of the entered estimates (${top[1].toFixed(2)} kg CO₂e).` : 'Add audit entries to receive source-specific suggestions.', 'Check that every quantity, unit, reporting period and emission factor matches the original bill and the reporting methodology.', 'Compare equivalent reporting periods before deciding whether emissions have increased or decreased.', 'Prioritize practical energy-efficiency actions, then recalculate using verified data to estimate the effect.'], disclaimer: 'Rule-based guidance, not an AI model output or a verified ESG assessment.' });
  }
  try {
    const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.AI_MODEL || 'gpt-4.1-mini', temperature: 0.2, messages: [{ role: 'system', content: 'You are ChainLedger AI Green Advisor. Give cautious, practical energy-efficiency suggestions based only on supplied audit data. Never claim regulatory compliance or independent verification. State assumptions and do not invent emission factors. Return concise plain text.' }, { role: 'user', content: JSON.stringify({ question: String(question).slice(0,1000), totalEstimatedKgCO2e: total, audits: clean }) }] }) });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: 'AI provider request failed.', detail: data?.error?.message || 'Check server AI configuration.' });
    res.json({ mode: 'ai_api', totalKgCO2e: total, advice: data.choices?.[0]?.message?.content || 'No advice returned.', disclaimer: 'AI-generated guidance; verify data and recommendations before business or compliance decisions.' });
  } catch { res.status(502).json({ error: 'Could not reach the configured AI provider.' }); }
});

async function requireUser(req, res, next) {
  if (!supabaseReady) return res.status(503).json({ error: 'Cloud database is not configured. Set Supabase environment variables first.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in and send an Authorization: Bearer <access_token> header.' });
  const { data, error } = await supabasePublic.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired login session.' });
  req.user = data.user; next();
}

app.get('/api/audits', requireUser, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('audits').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: 'Could not load audits.' }); res.json({ audits: data });
});
app.post('/api/audits', requireUser, async (req, res) => {
  const { name, source, quantity, unit, factor, kg_co2e, period } = req.body || {};
  if (!name || !source || !finitePositive(quantity) || !Number.isFinite(Number(factor)) || !Number.isFinite(Number(kg_co2e))) return res.status(400).json({ error: 'Provide valid audit name, source, quantity, factor and calculated emissions.' });
  const { data, error } = await supabaseAdmin.from('audits').insert({ user_id: req.user.id, name: String(name).slice(0,100), source: String(source).slice(0,60), quantity: Number(quantity), unit: String(unit || '').slice(0,30), factor: Number(factor), kg_co2e: Number(kg_co2e), period: String(period || '').slice(0,20) }).select().single();
  if (error) return res.status(500).json({ error: 'Could not save audit. Check database schema and access policies.' }); res.status(201).json({ audit: data });
});
app.delete('/api/audits/:id', requireUser, async (req, res) => {
  const { error } = await supabaseAdmin.from('audits').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: 'Could not delete audit.' }); res.json({ ok: true });
});

app.post('/api/passports', requireUser, async (req, res) => {
  const { audit_ids = [], organization = 'Organization', period = '' } = req.body || {};
  if (!Array.isArray(audit_ids) || !audit_ids.length || audit_ids.length > 500) return res.status(400).json({ error: 'Provide one or more audit_ids.' });
  const { data: audits, error: auditError } = await supabaseAdmin.from('audits').select('id,kg_co2e').eq('user_id', req.user.id).in('id', audit_ids);
  if (auditError || !audits?.length) return res.status(400).json({ error: 'No matching audits found for this user.' });
  const total = audits.reduce((s,a) => s + Number(a.kg_co2e), 0); const id = crypto.randomUUID();
  const { data, error } = await supabaseAdmin.from('passports').insert({ id, user_id: req.user.id, organization: String(organization).slice(0,120), period: String(period).slice(0,30), audit_ids: audits.map(a => a.id), total_kg_co2e: total, status: 'estimated_not_verified' }).select().single();
  if (error) return res.status(500).json({ error: 'Could not create passport record.' });
  const verificationUrl = `${(process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/$/,'')}/verify/${id}`; const qrDataUrl = await QRCode.toDataURL(verificationUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320 }); res.status(201).json({ passport: data, verificationUrl, qrDataUrl, warning: 'This verifies that a record exists; it is not independent environmental certification.' });
});
app.get('/api/passports/:id', async (req, res) => {
  if (!supabaseReady) return res.status(503).json({ error: 'Passport verification is not configured.' });
  const { data, error } = await supabaseAdmin.from('passports').select('id,organization,period,total_kg_co2e,status,created_at').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Passport record not found.' }); res.json({ passport: data, verification: 'record_exists_not_independent_certification' });
});
app.get('/verify/:id', async (req, res) => {
  if (!supabaseReady) return res.status(503).send('Passport verification is not configured yet.');
  const { data, error } = await supabaseAdmin.from('passports').select('id,organization,period,total_kg_co2e,status,created_at').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).send('Passport not found.');
  res.type('html').send(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Passport verification · ChainLedger AI</title><body style="margin:0;background:#06100f;color:#effff8;font:16px system-ui;padding:24px"><main style="max-width:680px;margin:auto;border:1px solid #34e6a1;border-radius:18px;padding:24px"><h1 style="color:#34e6a1">ChainLedger AI · Green Passport</h1><p><b>Record ID:</b> ${data.id}</p><p><b>Organization:</b> ${escapeHtml(data.organization)}</p><p><b>Period:</b> ${escapeHtml(data.period || 'Not specified')}</p><p><b>Estimated emissions:</b> ${Number(data.total_kg_co2e).toFixed(2)} kg CO₂e</p><p><b>Status:</b> ${escapeHtml(data.status)}</p><p style="color:#ffd166">This page confirms a database record only. It is not an independent audit, official ESG certificate, or proof of regulatory compliance.</p></main></body></html>`);
});
function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

app.post('/api/payments/order', requireUser, async (req, res) => {
  if (!razorpayReady) return res.status(503).json({ error: 'Payment gateway is not configured.' });
  const plan = req.body?.plan;
  const plans = { starter: 499900, pro: 499900 };
  if (!Object.hasOwn(plans, plan)) return res.status(400).json({ error: 'Unknown plan.' });
  try { const order = await razorpay.orders.create({ amount: plans[plan], currency: 'INR', receipt: `cl_${Date.now()}`, notes: { user_id: req.user.id, plan } }); res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID }); }
  catch { res.status(502).json({ error: 'Could not create payment order.' }); }
});
app.post('/api/payments/verify', requireUser, async (req, res) => {
  if (!razorpayReady) return res.status(503).json({ error: 'Payment gateway is not configured.' });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (![razorpay_order_id, razorpay_payment_id, razorpay_signature].every(Boolean)) return res.status(400).json({ error: 'Missing payment verification fields.' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpay_signature)))) return res.status(400).json({ verified: false, error: 'Payment signature mismatch.' });
  const { error } = await supabaseAdmin.from('payments').insert({ user_id: req.user.id, order_id: razorpay_order_id, payment_id: razorpay_payment_id, status: 'signature_verified' });
  if (error) return res.status(500).json({ verified: false, error: 'Payment signature checked but could not save record. Confirm webhook/server reconciliation before granting subscription access.' });
  res.json({ verified: true, status: 'signature_verified_pending_gateway_reconciliation', message: 'Signature verified. Production plan activation should additionally reconcile the order/payment state and webhook.' });
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Maximum size is 10 MB.' });
  if (err instanceof multer.MulterError || err?.message?.startsWith('Unsupported file type')) return res.status(400).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Unexpected server error.' });
});
app.listen(port, () => console.log(`ChainLedger AI API running at http://localhost:${port}; Supabase=${supabaseReady}; AI=${Boolean(process.env.AI_API_KEY)}; Razorpay=${razorpayReady}`));
