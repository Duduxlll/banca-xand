// server/server.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import axios from 'axios';
import pkg from 'pg';
const { Pool } = pkg;

/* =========================================================
   .env esperados (Render/produção)
   ---------------------------------------------------------
   NODE_ENV=production
   PORT=10000
   ORIGIN=https://seu-app.onrender.com
   STATIC_ROOT=..                 # raiz do site (pai de /server)

   ADMIN_USER=admin
   ADMIN_PASSWORD_HASH=<hash_bcrypt>
   JWT_SECRET=<64+ chars aleatórios>

   APP_PUBLIC_KEY=<chave-publica-pro-front>

   # >>> LivePix <<<
   PIX_PROVIDER=livepix
   LIVEPIX_CLIENT_ID=...
   LIVEPIX_CLIENT_SECRET=...
   LIVEPIX_API_BASE=https://api.livepix.gg           # confirme no painel
   LIVEPIX_REDIRECT_URL=                             # opcional
   LIVEPIX_WEBHOOK_SECRET=<seu-segredo-do-webhook>   # gerado por você
   LIVEPIX_WEBHOOK_ALLOWLIST=                        # opcional: "1.2.3.4,5.6.7.8"

   # Postgres (Render)
   DATABASE_URL=postgres://usuario:senha@host:5432/db
   ========================================================= */

const {
  PORT = 3000,
  ORIGIN = `http://localhost:3000`,
  STATIC_ROOT,

  ADMIN_USER = 'admin',
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,

  APP_PUBLIC_KEY,

  PIX_PROVIDER = 'livepix',

  LIVEPIX_CLIENT_ID,
  LIVEPIX_CLIENT_SECRET,
  LIVEPIX_API_BASE,
  LIVEPIX_REDIRECT_URL,
  LIVEPIX_WEBHOOK_SECRET,
  LIVEPIX_WEBHOOK_ALLOWLIST,

  DATABASE_URL
} = process.env;

const PROD = process.env.NODE_ENV === 'production';

// ===== valida env base =====
['ADMIN_USER','ADMIN_PASSWORD_HASH','JWT_SECRET'].forEach(k=>{
  if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (login)`); process.exit(1); }
});
if (!DATABASE_URL) { console.error('❌ Falta DATABASE_URL no .env'); process.exit(1); }

// ===== valida LivePix quando ativo =====
const isLivePix = (PIX_PROVIDER||'').toLowerCase() === 'livepix';
if (isLivePix) {
  ['LIVEPIX_CLIENT_ID','LIVEPIX_CLIENT_SECRET','LIVEPIX_API_BASE'].forEach(k=>{
    if(!process.env[k]) { console.error(`❌ Falta ${k} no .env (LivePix)`); process.exit(1); }
  });
}

// ===== infra =====
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, STATIC_ROOT || '..');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const q = (text, params) => pool.query(text, params);

// ===== utils =====
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function tok(){ return 'tok_' + crypto.randomBytes(18).toString('hex'); }

function timingSafeEq(a,b){
  const ba = Buffer.from(String(a)||''); const bb = Buffer.from(String(b)||'');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// token -> providerPaymentId (TTL 30 min)
const tokenStore = new Map();
const TOKEN_TTL_MS = 30 * 60 * 1000;
setInterval(()=> {
  const now = Date.now();
  for (const [k,v] of tokenStore) if (now - v.createdAt > TOKEN_TTL_MS) tokenStore.delete(k);
}, 60_000);

// ===== app =====
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// capturar RAW body para validar HMAC do webhook
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(data);
    req.rawBody = raw;
    // tenta parsear JSON — para rotas comuns
    try { req.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
    catch { req.body = {}; }
    next();
  });
});

app.use(cookieParser());
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.static(ROOT, { extensions: ['html'] }));

// ===== auth helpers =====
const loginLimiter = rateLimit({ windowMs: 10*60*1000, max: 20, standardHeaders: true, legacyHeaders: false });
function signSession(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' }); }
function verifySession(token)  { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }
function randomHex(n=32)       { return crypto.randomBytes(n).toString('hex'); }

function setAuthCookies(res, token) {
  const common = { sameSite:'strict', secure:PROD, maxAge: 2*60*60*1000, path:'/' };
  res.cookie('session', token, { ...common, httpOnly:true });
  res.cookie('csrf',    randomHex(16), { ...common, httpOnly:false });
}
function clearAuthCookies(res){
  const common = { sameSite:'strict', secure:PROD, path:'/' };
  res.clearCookie('session', { ...common, httpOnly:true });
  res.clearCookie('csrf',    { ...common });
}
function requireAuth(req, res, next){
  const token = req.cookies?.session;
  const data  = token && verifySession(token);
  if (!data) return res.status(401).json({ error:'unauthorized' });
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const csrfH = req.get('X-CSRF-Token'); const csrfC = req.cookies?.csrf;
    if (!csrfH || csrfH !== csrfC) return res.status(403).json({ error:'invalid_csrf' });
  }
  req.user = data; next();
}

// ===== SSE =====
const sseClients = new Set();
function sseSendAll(event, payload = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const msg  = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch {} }
}
app.get('/api/stream', requireAuth, (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials','true');
  res.flushHeaders?.();
  sseClients.add(res);
  const ping = setInterval(()=>{ try { res.write(`event: ping\ndata: {}\n\n`);} catch {} }, 25000);
  req.on('close', ()=>{ clearInterval(ping); sseClients.delete(res); try{res.end();}catch{} });
});

// ===== auth routes =====
app.post('/api/auth/login', loginLimiter, async (req,res)=>{
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error:'missing_fields' });
  const userOk = username === ADMIN_USER;
  const passOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!userOk || !passOk) return res.status(401).json({ error:'invalid_credentials' });
  const token = signSession({ sub: ADMIN_USER, role:'admin' }); setAuthCookies(res, token);
  res.json({ ok:true });
});
app.post('/api/auth/logout', (req,res)=>{ clearAuthCookies(res); res.json({ ok:true }); });
app.get('/api/auth/me', (req,res)=>{
  const token = req.cookies?.session; const data = token && verifySession(token);
  if (!data) return res.status(401).json({ error:'unauthorized' });
  res.json({ user:{ username: data.sub } });
});
app.get('/area.html', (req,res)=>{
  const token = req.cookies?.session;
  if (!token || !verifySession(token)) return res.redirect('/login.html');
  return res.sendFile(path.join(ROOT,'area.html'));
});

// ===== health =====
app.get('/health', async (req,res)=>{
  try {
    await q('select 1');
    return res.json({ ok:true, provider: (PIX_PROVIDER||'').toLowerCase() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});

/* =========================================================
   ADAPTER DO PROVEDOR PIX — LivePix
   (confirme as rotas/nomes de campos na doc oficial)
   ========================================================= */

// 1) Access token (ex.: OAuth2 client_credentials)
async function livepixGetAccessToken(){
  const base = LIVEPIX_API_BASE.replace(/\/+$/,'');
  const url = `${base}/oauth/token`; // CONFIRMAR NA DOC
  const resp = await axios.post(
    url,
    new URLSearchParams({ grant_type:'client_credentials' }).toString(),
    {
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      auth: { username: LIVEPIX_CLIENT_ID, password: LIVEPIX_CLIENT_SECRET }
    }
  );
  return resp.data.access_token; // confirme o campo
}

// 2) Criar pagamento/checkout
async function livepixCreatePayment({ nome, valorCentavos, tipo, chave }){
  const access = await livepixGetAccessToken();
  const base = LIVEPIX_API_BASE.replace(/\/+$/,'');
  const url  = `${base}/v1/payments`; // CONFIRMAR NA DOC

  const body = {
    amount: (valorCentavos/100).toFixed(2), // "10.00"
    currency: 'BRL',
    payer_name: nome,
    description: 'Depósito via site',
    metadata: { tipo, chave }, // volta no webhook
    success_url: LIVEPIX_REDIRECT_URL || undefined,
    cancel_url: LIVEPIX_REDIRECT_URL || undefined
  };

  const { data } = await axios.post(url, body, {
    headers:{ Authorization:`Bearer ${access}`, 'Content-Type':'application/json' }
  });

  return {
    providerPaymentId: data.id,
    redirectUrl: data.checkout_url || data.url
  };
}

// 3) Consultar status (opcional — webhook é a verdade)
async function livepixGetPaymentStatus(providerPaymentId){
  const access = await livepixGetAccessToken();
  const base = LIVEPIX_API_BASE.replace(/\/+$/,'');
  const url  = `${base}/v1/payments/${encodeURIComponent(providerPaymentId)}`; // CONFIRMAR NA DOC
  const { data } = await axios.get(url, { headers:{ Authorization:`Bearer ${access}` } });
  const paid = (data.status === 'paid' || data.status === 'succeeded' || data.paid === true);
  return paid ? 'CONCLUIDA' : 'PENDENTE';
}

/* =========================================================
   ROTAS PIX/LivePix
   ========================================================= */

// (Novo) endpoint que teu front estava chamando
app.post('/api/livepix/create', async (req, res) => {
  try {
    if (!isLivePix) return res.status(400).json({ error: 'provider_mismatch' });
    const { nome, valorCentavos, tipo=null, chave=null } = req.body || {};
    if (!nome || !valorCentavos || valorCentavos < 1000) {
      return res.status(400).json({ error: 'Dados inválidos (mínimo R$ 10,00)' });
    }

    const { providerPaymentId, redirectUrl } = await livepixCreatePayment({ nome, valorCentavos, tipo, chave });

    const tokenOpaque = tok();
    tokenStore.set(tokenOpaque, { providerPaymentId, createdAt: Date.now() });

    return res.json({ token: tokenOpaque, redirectUrl });
  } catch (err) {
    console.error('Erro /api/livepix/create:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao iniciar pagamento' });
  }
});

// Compat: se teu front ainda bater em /api/pix/cob, responde igual
app.post('/api/pix/cob', async (req, res) => {
  try {
    if (!isLivePix) return res.status(400).json({ error: 'provider_mismatch' });
    const { nome, valorCentavos, tipo=null, chave=null } = req.body || {};
    if (!nome || !valorCentavos || valorCentavos < 1000) {
      return res.status(400).json({ error: 'Dados inválidos (mínimo R$ 10,00)' });
    }
    const { providerPaymentId, redirectUrl } = await livepixCreatePayment({ nome, valorCentavos, tipo, chave });
    const tokenOpaque = tok();
    tokenStore.set(tokenOpaque, { providerPaymentId, createdAt: Date.now() });
    return res.json({ token: tokenOpaque, redirectUrl });
  } catch (err) {
    console.error('Erro /api/pix/cob:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao iniciar pagamento' });
  }
});

// (Opcional) polling por token
app.get('/api/pix/status/:token', async (req, res) => {
  try {
    if (!isLivePix) return res.status(400).json({ error:'apenas_livepix' });
    const rec = tokenStore.get(req.params.token);
    if (!rec) return res.status(404).json({ error: 'token_not_found' });
    const status = await livepixGetPaymentStatus(rec.providerPaymentId);
    res.json({ status });
  } catch (err) {
    console.error('Erro status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao consultar status' });
  }
});

/* =========================================================
   WEBHOOK LivePix — verdade do pagamento
   ========================================================= */
app.post('/api/livepix/webhook', async (req, res) => {
  try {
    // (Opcional) allowlist de IP
    if (LIVEPIX_WEBHOOK_ALLOWLIST) {
      const allow = LIVEPIX_WEBHOOK_ALLOWLIST.split(',').map(s=>s.trim()).filter(Boolean);
      const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || '';
      if (allow.length && !allow.includes(ip)) {
        return res.status(403).json({ error:'ip_not_allowed' });
      }
    }

    // (Opcional) assinatura HMAC (use RAW body)
    if (LIVEPIX_WEBHOOK_SECRET) {
      const signature = req.get('X-LivePix-Signature') || req.get('X-Signature');
      const check = crypto.createHmac('sha256', LIVEPIX_WEBHOOK_SECRET)
                          .update(req.rawBody || Buffer.from(''))
                          .digest('hex');
      if (!signature || !timingSafeEq(signature, check)) {
        return res.status(401).json({ error:'invalid_signature' });
      }
    }

    // Normaliza payload (ajuste aos campos reais da LivePix)
    const data = req.body?.data || req.body?.object || req.body || {};
    const paid = (data.status === 'paid' || data.status === 'succeeded' || data.paid === true);
    const valorCentavos =
      (typeof data.amount_cents === 'number' ? data.amount_cents :
       Math.round(Number(String(data.amount || data.value || 0)) * 100)) || 0;
    const nome = data.payer_name || data.customer_name || data.name || 'Contribuinte';
    const meta = data.metadata || {};

    if (!paid) return res.json({ ok:true, ignored:true });
    if (!valorCentavos || valorCentavos < 1) return res.status(400).json({ error:'valor_invalido' });

    const id = uid();
    const { rows } = await q(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
       values ($1,$2,$3,$4,$5,$6, now())
       returning id, nome,
                 deposito_cents as "depositoCents",
                 banca_cents    as "bancaCents",
                 pix_type       as "pixType",
                 pix_key        as "pixKey",
                 created_at     as "createdAt"`,
      [id, nome, valorCentavos, null, meta.tipo || null, meta.chave || null]
    );

    sseSendAll('bancas-changed', { reason: 'webhook-paid' });
    return res.json({ ok:true, ...rows[0] });
  } catch (e) {
    console.error('livepix webhook:', e.response?.data || e.message);
    return res.status(500).json({ error:'webhook_fail' });
  }
});

/* =========================================================
   Compat: /api/pix/confirmar deixa de ser usado no LivePix
   ========================================================= */
app.post('/api/pix/confirmar', (_req,res)=>{
  if (isLivePix) return res.status(400).json({ error:'use_webhook_livepix' });
  return res.status(400).json({ error:'no_provider' });
});

/* =========================================================
   BANCAS (Postgres)
   ========================================================= */
const areaAuth = [requireAuth];

app.get('/api/bancas', areaAuth, async (req,res)=>{
  const { rows } = await q(
    `select id, nome,
            deposito_cents as "depositoCents",
            banca_cents    as "bancaCents",
            pix_type       as "pixType",
            pix_key        as "pixKey",
            created_at     as "createdAt"
     from bancas
     order by created_at desc`
  );
  res.json(rows);
});

app.post('/api/bancas', areaAuth, async (req,res)=>{
  const { nome, depositoCents, pixType=null, pixKey=null } = req.body || {};
  if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
    return res.status(400).json({ error:'dados_invalidos' });
  }
  const id = uid();
  const { rows } = await q(
    `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at)
     values ($1,$2,$3,$4,$5,$6, now())
     returning id, nome, deposito_cents as "depositoCents", banca_cents as "bancaCents",
               pix_type as "pixType", pix_key as "pixKey", created_at as "createdAt"`,
    [id, nome, depositoCents, null, pixType, pixKey]
  );
  sseSendAll('bancas-changed', { reason: 'insert' });
  res.json(rows[0]);
});

app.patch('/api/bancas/:id', areaAuth, async (req,res)=>{
  const { bancaCents } = req.body || {};
  if (typeof bancaCents !== 'number' || bancaCents < 0) {
    return res.status(400).json({ error:'dados_invalidos' });
  }
  const { rows } = await q(
    `update bancas set banca_cents = $2
     where id = $1
     returning id, nome,
               deposito_cents as "depositoCents",
               banca_cents    as "bancaCents",
               pix_type       as "pixType",
               pix_key        as "pixKey",
               created_at     as "createdAt"`,
    [req.params.id, bancaCents]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });
  sseSendAll('bancas-changed', { reason: 'update' });
  res.json(rows[0]);
});

app.post('/api/bancas/:id/to-pagamento', areaAuth, async (req,res)=>{
  const { bancaCents } = req.body || {};
  const client = await pool.connect();
  try{
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, deposito_cents, banca_cents, pix_type, pix_key, created_at
       from bancas where id = $1 for update`,
      [req.params.id]
    );
    if (!sel.rows.length) { await client.query('rollback'); return res.status(404).json({ error:'not_found' }); }
    const b = sel.rows[0];

    const bancaFinal = (typeof bancaCents === 'number' && bancaCents >= 0)
      ? bancaCents
      : (typeof b.banca_cents === 'number' && b.banca_cents > 0 ? b.banca_cents : b.deposito_cents);

    await client.query(
      `insert into pagamentos (id, nome, pagamento_cents, pix_type, pix_key, status, created_at, paid_at)
       values ($1,$2,$3,$4,$5,'nao_pago',$6,null)`,
      [b.id, b.nome, bancaFinal, b.pix_type, b.pix_key, b.created_at]
    );
    await client.query(`delete from bancas where id = $1`, [b.id]);

    await client.query('commit');
    sseSendAll('bancas-changed', { reason: 'moved' });
    sseSendAll('pagamentos-changed', { reason: 'moved' });
    res.json({ ok:true });
  }catch(e){
    await client.query('rollback');
    console.error('to-pagamento:', e.message);
    res.status(500).json({ error:'falha_mover' });
  }finally{
    client.release();
  }
});

app.delete('/api/bancas/:id', areaAuth, async (req,res)=>{
  const r = await q(`delete from bancas where id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error:'not_found' });
  sseSendAll('bancas-changed', { reason: 'delete' });
  res.json({ ok:true });
});

/* =========================================================
   PAGAMENTOS (Postgres)
   ========================================================= */
app.get('/api/pagamentos', areaAuth, async (req,res)=>{
  const { rows } = await q(
    `select id, nome,
            pagamento_cents as "pagamentoCents",
            pix_type        as "pixType",
            pix_key         as "pixKey",
            status,
            created_at      as "createdAt",
            paid_at         as "paidAt"
     from pagamentos
     order by created_at desc`
  );
  res.json(rows);
});

app.patch('/api/pagamentos/:id', areaAuth, async (req,res)=>{
  const { status } = req.body || {};
  if (!['pago','nao_pago'].includes(status)) return res.status(400).json({ error:'status_invalido' });
  const { rows } = await q(
    `update pagamentos
       set status = $2,
           paid_at = case when $2 = 'pago' then now() else null end
     where id = $1
     returning id, nome,
               pagamento_cents as "pagamentoCents",
               pix_type as "PixType",
               pix_key  as "pixKey",
               status, created_at as "CreatedAt", paid_at as "PaidAt"`,
    [req.params.id, status]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });
  sseSendAll('pagamentos-changed', { reason: 'update-status' });
  res.json(rows[0]);
});

app.delete('/api/pagamentos/:id', areaAuth, async (req,res)=>{
  const r = await q(`delete from pagamentos where id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error:'not_found' });
  sseSendAll('pagamentos-changed', { reason: 'delete' });
  res.json({ ok:true });
});

// ===== start =====
app.listen(PORT, async () => {
  try { await q('select 1'); console.log('🗄️  Postgres conectado'); }
  catch(e){ console.error('❌ Postgres falhou:', e.message); }
  console.log(`✅ Server rodando em ${ORIGIN} (NODE_ENV=${process.env.NODE_ENV||'dev'})`);
  console.log(`🗂  Servindo estáticos de: ${ROOT}`);
  console.log(`🔒 /area.html protegido por sessão; login em /login.html`);
  console.log(`🔁 Provedor PIX: ${(PIX_PROVIDER||'').toLowerCase()}`);
});
