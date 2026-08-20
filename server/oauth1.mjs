// Minimal OAuth 1.0a "Sign in with X" signing, zero dependencies (node:crypto only).
//
// Why 1.0a and not OAuth 2.0 PKCE: the app credentials we have are a Consumer
// Key/Secret pair, which is the 1.0a pair. X's OAuth 2.0 flow needs a separate
// "OAuth 2.0 Client ID/Secret" that only appears once OAuth 2.0 user auth is
// switched on in the developer portal. 1.0a also happens to be a better fit
// here: its access_token response hands back screen_name and user_id inline,
// so we learn who logged in without a follow-up API call (which on the free
// tier would otherwise be a /2/users/me round trip).
import crypto from "node:crypto";

// RFC 3986 percent-encoding. encodeURIComponent leaves ! * ' ( ) alone but
// OAuth 1.0a requires them encoded, and any mismatch here silently breaks the
// signature with an opaque 401 from X -- so it is worth doing exactly.
export function pct(value) {
  return encodeURIComponent(String(value)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// The signature base string: METHOD & encoded-url & encoded-sorted-params.
// Params must be sorted by encoded key, then by encoded value.
function signatureBaseString(method, url, params) {
  const encoded = Object.entries(params)
    .map(([k, v]) => [pct(k), pct(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => k + "=" + v)
    .join("&");
  return [method.toUpperCase(), pct(url), pct(encoded)].join("&");
}

function sign(baseString, consumerSecret, tokenSecret) {
  const key = pct(consumerSecret) + "&" + pct(tokenSecret || "");
  return crypto.createHmac("sha1", key).update(baseString).digest("base64");
}

// Builds the Authorization header for a signed request. `extra` carries any
// protocol params beyond the standard set (oauth_callback, oauth_verifier),
// `body` carries form-encoded body params, which participate in the signature
// but must NOT appear in the header.
export function authHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, extra = {}, body = {} }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...extra,
  };
  if (token) oauth.oauth_token = token;

  const base = signatureBaseString(method, url, { ...oauth, ...body });
  oauth.oauth_signature = sign(base, consumerSecret, tokenSecret);

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => pct(k) + '="' + pct(oauth[k]) + '"')
      .join(", ")
  );
}

// X returns these endpoints' payloads as form-encoded text, not JSON.
export function parseFormEncoded(text) {
  const out = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = i === -1 ? pair : pair.slice(0, i);
    const v = i === -1 ? "" : pair.slice(i + 1);
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}
