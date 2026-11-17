// api/_mp.js — Cliente de la API de Mercado Pago (Suscripciones / preapproval).
// El Access Token vive en MP_ACCESS_TOKEN (variable de entorno de Vercel,
// Production). Nunca va en el código ni en el frontend.
// Docs: https://www.mercadopago.com.mx/developers/es/docs/subscriptions/overview
// Flujo v1 (suscripción sin plan asociado en MP): el endpoint crea una
// suscripción "pending" y devuelve init_point; el cliente autoriza el cobro
// recurrente en la página de Mercado Pago y el webhook la marca autorizada.
// No se usa card_token_id: DMD no toca ni ve datos de tarjetas.

const PLANS = {
  pro:   { amount: 79,  name: 'Plan Emprendedor Pro - DMD' },
  pyme:  { amount: 189, name: 'Plan Crecimiento PyME - DMD' },
  elite: { amount: 299, name: 'Plan Corporativo Élite - DMD' },
};

const MP_API = 'https://api.mercadopago.com';
const SITE = 'https://crear.dmdmx.dev';

function mpConfigured() {
  return !!process.env.MP_ACCESS_TOKEN;
}

async function mpCall(method, path, body) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    const e = new Error('MP_ACCESS_TOKEN no configurado en el servidor');
    e.code = 'NO_MP';
    throw e;
  }
  const res = await fetch(MP_API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const err = new Error('Mercado Pago respondió ' + res.status);
    err.code = 'MP_ERROR';
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

module.exports = { PLANS, SITE, mpConfigured, mpCall };
