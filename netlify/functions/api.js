// One server file for StyleTry: AI try-on, picture lookup from a shop link, and a health check.
const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

const j = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const isPrivate = (h) =>
  /^(localhost|.*\.local|.*\.internal)$/i.test(h) ||
  /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) ||
  /^\[?(::1|fc|fd|fe80)/i.test(h);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function get(url, accept) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 7000);
  try {
    return await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-GB,en;q=0.9" } });
  } finally { clearTimeout(t); }
}
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&#38;/g, "&");

function pickImage(html, base) {
  const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map((m) => m[0]);
  const want = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];
  for (const w of want) {
    for (const m of metas) {
      const p = m.match(/(?:property|name)=["']([^"']+)["']/i);
      const c = m.match(/content=["']([^"']+)["']/i);
      if (p && c && p[1].toLowerCase() === w) { try { return new URL(decode(c[1]), base).href; } catch {} }
    }
  }
  const ld = html.match(/"image"\s*:\s*(?:\[\s*)?"([^"]+)"/);
  if (ld) { try { return new URL(decode(ld[1].replace(/\\\//g, "/")), base).href; } catch {} }
  return null;
}

async function toData(res) {
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return { error: "That picture type is not supported. Use Add photo instead." };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4000000) return { error: "That picture is too large. Use Add photo instead." };
  return { image: `data:${type};base64,${buf.toString("base64")}` };
}

async function fetchGarment(event) {
  let u;
  try { u = new URL((event.queryStringParameters || {}).url || ""); } catch { return j(400, { error: "That does not look like a link." }); }
  if (!/^https?:$/.test(u.protocol) || isPrivate(u.hostname)) return j(400, { error: "That link can't be used." });

  try {
    const res = await get(u.href, "text/html,image/*;q=0.8,*/*;q=0.5");
    if (!res.ok) return j(422, { error: "That shop would not let us open the page. Use Add photo instead." });
    const ct = (res.headers.get("content-type") || "").toLowerCase();

    if (ct.startsWith("image/")) {
      const d = await toData(res);
      return d.error ? j(422, d) : j(200, d);
    }
    const html = (await res.text()).slice(0, 900000);
    const img = pickImage(html, u.href);
    if (!img) return j(422, { error: "We could not find a picture on that page. Use Add photo instead." });
    const iu = new URL(img);
    if (!/^https?:$/.test(iu.protocol) || isPrivate(iu.hostname)) return j(422, { error: "We could not use that picture." });
    const ir = await get(iu.href, "image/jpeg,image/png,image/webp,*/*;q=0.5");
    if (!ir.ok) return j(422, { error: "That shop blocked the picture. Use Add photo instead." });
    const d = await toData(ir);
    return d.error ? j(422, d) : j(200, d);
  } catch {
    return j(502, { error: "Could not open that link. Use Add photo instead." });
  }
}

async function tryonStart(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const findKey = () => {
  const names = Object.keys(process.env).filter((n) => /fashn/i.test(n));
  for (const n of names) { const v = (process.env[n] || "").trim().replace(/^["']|["']$/g, ""); if (v) return v; }
  return "";
};
const key = findKey();
  if (!key) return json(500, { error: "The AI service is not set up yet." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Bad request." }); }

  const okImg = (s) => typeof s === "string" && s.startsWith("data:image/") && s.length < 4000000;
  const okModel = (v) => {
    if (okImg(v)) return true;
    try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)fashn\.ai$/.test(u.hostname); } catch { return false; }
  };
  if (!okModel(body.model_image) || !okImg(body.garment_image)) {
    return json(400, { error: "Please send your photo and a dress photo." });
  }

  try {
    const r = await fetch("https://api.fashn.ai/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model_name: "tryon-v1.6",
        inputs: {
          model_image: body.model_image,
          garment_image: body.garment_image,
          category: ["auto", "tops", "bottoms", "one-pieces"].includes(body.category) ? body.category : "auto",
          garment_photo_type: ["auto", "flat-lay", "model"].includes(body.garment_photo_type) ? body.garment_photo_type : "auto",
          mode: "quality",
          output_format: "jpeg",
        },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id) {
      return json(502, { error: "The AI service could not start. Please try again." });
    }
    return json(200, { id: data.id });
  } catch {
    return json(502, { error: "Could not reach the AI service." });
  }
}

async function tryonStatus(event) {
  const findKey = () => {
  const names = Object.keys(process.env).filter((n) => /fashn/i.test(n));
  for (const n of names) { const v = (process.env[n] || "").trim().replace(/^["']|["']$/g, ""); if (v) return v; }
  return "";
};
const key = findKey();
  if (!key) return json(500, { error: "The AI service is not set up yet." });

  const id = (event.queryStringParameters || {}).id || "";
  if (!/^[\w-]{6,80}$/.test(id)) return json(400, { error: "Bad request." });

  try {
    const r = await fetch(`https://api.fashn.ai/v1/status/${id}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const d = await r.json().catch(() => ({}));
    const output = Array.isArray(d.output) && d.output.length ? d.output[0] : null;
    return json(200, {
      status: d.status || "processing",
      output,
      error: d.error ? "The AI could not finish this one. Try a clearer photo." : null,
    });
  } catch {
    return json(502, { error: "Could not reach the AI service." });
  }
}

async function health() {
  const names = Object.keys(process.env).filter((n) => /fashn/i.test(n));
  const found = names.map((n) => ({ name: n, hasValue: !!(process.env[n] || "").trim() }));
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ functionsRunning: true, keyVariablesFound: found }, null, 2),
  };
}

exports.handler = async (event) => {
  const route = (event.queryStringParameters || {}).route;
  if (route === "health") return health();
  if (route === "tryon-start") return tryonStart(event);
  if (route === "tryon-status") return tryonStatus(event);
  if (route === "fetch-garment") return fetchGarment(event);
  return json(404, { error: "Not found" });
};
