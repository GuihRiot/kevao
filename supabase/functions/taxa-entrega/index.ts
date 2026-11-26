// Calcula a distância de carro da KEVÃO até o cliente e grava uma cotação de taxa.
// Com GPS, também devolve o nome da rua e o bairro para preencher o endereço.
// Usa OpenRouteService em api.heigit.org (ORS_KEY, grátis; o api.openrouteservice.org saiu do ar em 24/11/2026) ou Google Routes (GOOGLE_MAPS_KEY).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ORIGEM = "Av. Saul Elkind, 3665 - Alto da Boa Vista, Londrina - PR, 86030-030";
const RET = { minLat: -23.62, maxLat: -23.05, minLon: -51.45, maxLon: -50.85 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const SURL = Deno.env.get("SUPABASE_URL")!, SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rpc = (fn: string, body: unknown) => fetch(SURL + "/rest/v1/rpc/" + fn, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: SKEY, Authorization: "Bearer " + SKEY }, body: JSON.stringify(body),
});

const cacheChave: Record<string, { v: string | null; t: number }> = {};
async function chave(nome: string) {
  const env = Deno.env.get(nome); if (env) return env;
  const c = cacheChave[nome]; if (c && Date.now() - c.t < 300e3) return c.v;
  let v: string | null = null;
  try { const r = await rpc("segredo", { p_nome: nome }); if (r.ok) v = await r.json(); } catch { /* */ }
  cacheChave[nome] = { v: v || null, t: Date.now() }; return v || null;
}

const usos = new Map<string, number[]>();
function excedeu(ip: string) {
  const agora = Date.now(), h = (usos.get(ip) || []).filter((t) => agora - t < 3600e3);
  h.push(agora); usos.set(ip, h); return h.length > 40;
}

let motivo = "";
let origemOrs: [number, number] | null = null; // [lon, lat]
async function geocodeOrs(key: string, texto: string) {
  const u = new URL("https://api.heigit.org/pelias/v1/search");
  u.searchParams.set("api_key", key); u.searchParams.set("text", texto); u.searchParams.set("size", "1");
  u.searchParams.set("boundary.country", "BR");
  u.searchParams.set("boundary.rect.min_lat", String(RET.minLat)); u.searchParams.set("boundary.rect.max_lat", String(RET.maxLat));
  u.searchParams.set("boundary.rect.min_lon", String(RET.minLon)); u.searchParams.set("boundary.rect.max_lon", String(RET.maxLon));
  u.searchParams.set("focus.point.lat", "-23.31"); u.searchParams.set("focus.point.lon", "-51.16");
  const r = await fetch(u, { headers: { Authorization: key } }); const g = await r.json().catch(() => ({}));
  const f = g?.features?.[0];
  if (!r.ok || !f) { motivo = `geocode ${r.status} ${JSON.stringify(g?.error || g?.geocoding?.errors || "").slice(0, 160)}`; return null; }
  const layer = f.properties?.layer || "";
  if (!["address", "street", "venue", "neighbourhood", "postalcode"].includes(layer)) { motivo = "geocode layer " + layer; return null; }
  return { c: f.geometry.coordinates as [number, number], preciso: layer === "address" || layer === "venue", rotulo: f.properties?.label || texto, layer };
}
// rua e bairro a partir do GPS
async function reversoOrs(key: string, lat: number, lng: number) {
  try {
    const u = new URL("https://api.heigit.org/pelias/v1/reverse");
    u.searchParams.set("api_key", key); u.searchParams.set("point.lat", String(lat)); u.searchParams.set("point.lon", String(lng));
    u.searchParams.set("size", "5"); u.searchParams.set("layers", "address,street");
    const r = await fetch(u, { headers: { Authorization: key } }); const g = await r.json().catch(() => ({}));
    const fs = (g?.features || []) as Array<{ properties: Record<string, string> }>;
    if (!r.ok || !fs.length) return null;
    const p = fs[0].properties;
    const rua = p.street || (p.layer === "street" ? p.name : "") || "";
    const bairro = p.neighbourhood || fs.map((f) => f.properties.neighbourhood).find(Boolean) || p.borough || "";
    return { rua, bairro, numero: p.housenumber || "" };
  } catch { return null; }
}
async function kmOrs(key: string, dest: [number, number]) {
  if (!origemOrs) { const o = await geocodeOrs(key, ORIGEM); if (!o) { motivo = "origem: " + motivo; return null; } origemOrs = o.c; }
  const r = await fetch("https://api.heigit.org/openrouteservice/v2/directions/driving-car", {
    method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ coordinates: [origemOrs, dest], radiuses: [800, 800] }),
  });
  const g = await r.json().catch(() => ({}));
  const m = g?.routes?.[0]?.summary?.distance;
  if (!(r.ok && typeof m === "number")) motivo = `rota ${r.status} ${JSON.stringify(g?.error || "").slice(0, 160)}`;
  return r.ok && typeof m === "number" ? m / 1000 : null;
}
async function kmGoogle(key: string, destino: Record<string, unknown>) {
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "routes.distanceMeters" },
    body: JSON.stringify({ origin: { address: ORIGEM }, destination: destino, travelMode: "DRIVE", languageCode: "pt-BR", regionCode: "BR" }),
  });
  const g = await r.json().catch(() => ({}));
  const m = g?.routes?.[0]?.distanceMeters;
  if (!(r.ok && typeof m === "number")) motivo = `google ${r.status} ${JSON.stringify(g?.error?.status || "")}`;
  return r.ok && typeof m === "number" ? m / 1000 : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "METODO" }, 405);
  motivo = "";
  const ors = await chave("ORS_KEY"), goo = ors ? null : await chave("GOOGLE_MAPS_KEY");
  if (!ors && !goo) return json({ erro: "SEM_CHAVE" }, 503);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  if (excedeu(ip)) return json({ erro: "LIMITE" }, 429);
  let b: { endereco?: string; lat?: number; lng?: number } = {};
  try { b = await req.json(); } catch { return json({ erro: "ENTRADA" }, 400); }
  const gps = typeof b.lat === "number" && typeof b.lng === "number" && Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180;
  let texto = "";
  if (!gps) {
    const e = String(b.endereco || "").trim().slice(0, 200);
    if (e.length < 5) return json({ erro: "ENDERECO" }, 400);
    texto = /londrina/i.test(e) ? e : e + ", Londrina - PR";
  }
  let km: number | null = null, preciso = true, rotulo = gps ? `GPS ${b.lat!.toFixed(5)},${b.lng!.toFixed(5)}` : texto;
  let end: { rua: string; bairro: string; numero: string } | null = null;
  try {
    if (ors) {
      let dest: [number, number];
      if (gps) {
        dest = [b.lng!, b.lat!];
        const [k, e] = await Promise.all([kmOrs(ors, dest), reversoOrs(ors, b.lat!, b.lng!)]);
        km = k; end = e;
      } else {
        const g = await geocodeOrs(ors, texto); if (!g) return json({ erro: "NAO_ACHOU", motivo }, 422);
        dest = g.c; preciso = g.preciso; rotulo = g.rotulo; km = await kmOrs(ors, dest);
      }
    } else {
      km = await kmGoogle(goo!, gps ? { location: { latLng: { latitude: b.lat, longitude: b.lng } } } : { address: texto });
    }
  } catch (x) { km = null; motivo = "excecao " + String(x).slice(0, 120); }
  if (km === null || km > 80) return json({ erro: "NAO_ACHOU", motivo: motivo || (km ? "km>80" : "") }, 422);
  const s = await rpc("salva_cotacao", { p_km: km, p_destino: (preciso ? "" : "[aprox.] ") + (end?.rua ? `${end.rua} (${rotulo})` : rotulo) });
  if (!s.ok) return json({ erro: "SERVIDOR" }, 500);
  return json({ ...(await s.json()), aproximado: !preciso, local: rotulo, rua: end?.rua || "", bairro: end?.bairro || "", numero: end?.numero || "" });
});
