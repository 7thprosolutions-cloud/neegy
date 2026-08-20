// The three-legged "Sign in with X" (OAuth 1.0a) dance.
//
//   1. POST oauth/request_token  -> a temporary token we stash server-side
//   2. send the user to oauth/authenticate to approve
//   3. POST oauth/access_token   -> a durable user token, plus user_id and
//                                   screen_name inline (no extra API call)
//
// Step 1 is where app configuration bites: an X app registered as a *desktop
// or native* app rejects any real callback URL with error 417 and only accepts
// the literal value "oob", which switches X into PIN mode (user copies a 7-digit
// code back into our page). We support both -- redirect when the app allows it,
// PIN when it does not -- so login works before and after the portal is
// reconfigured. See README-auth.md.
import { authHeader, parseFormEncoded } from "./oauth1.mjs";
import { stashPending, takePending } from "./store.mjs";

const REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token";
const AUTHENTICATE_URL = "https://api.x.com/oauth/authenticate";
const ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token";
const USERS_ME_URL = "https://api.x.com/2/users/me?user.fields=profile_image_url,name,username";

export const DESKTOP_APP_ERROR = 417;

function creds(env) {
  const consumerKey = env.X_CONSUMER_KEY;
  const consumerSecret = env.X_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error("X_CONSUMER_KEY / X_CONSUMER_SECRET are not set (see .env)");
  }
  return { consumerKey, consumerSecret };
}

// Step 1. Returns { mode: "redirect" | "pin", authorizeUrl, requestToken }.
export async function beginLogin(env, callbackUrl) {
  const { consumerKey, consumerSecret } = creds(env);

  async function requestToken(callback) {
    const res = await fetch(REQUEST_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader({
          method: "POST",
          url: REQUEST_TOKEN_URL,
          consumerKey,
          consumerSecret,
          extra: { oauth_callback: callback },
        }),
      },
    });
    return { res, text: await res.text() };
  }

  let mode = "redirect";
  let { res, text } = await requestToken(callbackUrl);

  // 417 means the app is registered as desktop/native: retry in PIN mode
  // rather than dead-ending the user on an error page.
  if (!res.ok && text.includes('code="' + DESKTOP_APP_ERROR + '"')) {
    mode = "pin";
    ({ res, text } = await requestToken("oob"));
  }

  if (!res.ok) {
    throw new Error(`X request_token failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const parsed = parseFormEncoded(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error("X request_token returned no token: " + text.slice(0, 300));
  }

  stashPending(parsed.oauth_token, parsed.oauth_token_secret);
  return {
    mode,
    requestToken: parsed.oauth_token,
    authorizeUrl: `${AUTHENTICATE_URL}?oauth_token=${encodeURIComponent(parsed.oauth_token)}`,
  };
}

// Step 3. `verifier` is the oauth_verifier from the callback query string, or
// the PIN the user typed. Both are the same value as far as X is concerned.
export async function completeLogin(env, requestToken, verifier) {
  const { consumerKey, consumerSecret } = creds(env);
  const requestSecret = takePending(requestToken);
  if (requestSecret === null) {
    throw new Error("This login link has expired or was already used -- start again.");
  }

  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader({
        method: "POST",
        url: ACCESS_TOKEN_URL,
        consumerKey,
        consumerSecret,
        token: requestToken,
        tokenSecret: requestSecret,
        extra: { oauth_verifier: verifier },
      }),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`X access_token failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const parsed = parseFormEncoded(text);
  if (!parsed.oauth_token || !parsed.user_id) {
    throw new Error("X access_token returned no user: " + text.slice(0, 300));
  }

  // Display name and avatar are a bonus, not a requirement: /2/users/me can be
  // unavailable depending on the app's API access tier, and login must still
  // succeed on just the screen_name we already have.
  const extra = await fetchProfile(env, parsed.oauth_token, parsed.oauth_token_secret).catch(() => null);

  return {
    xUserId: parsed.user_id,
    handle: parsed.screen_name,
    name: extra?.name || parsed.screen_name,
    avatar: extra?.avatar || null,
  };
}

async function fetchProfile(env, token, tokenSecret) {
  const { consumerKey, consumerSecret } = creds(env);
  // The query string participates in the OAuth signature, so those params have
  // to be handed to the signer as body/query params, not just left in the URL.
  const url = USERS_ME_URL.split("?")[0];
  const query = Object.fromEntries(new URL(USERS_ME_URL).searchParams);
  const res = await fetch(USERS_ME_URL, {
    headers: {
      Authorization: authHeader({
        method: "GET",
        url,
        consumerKey,
        consumerSecret,
        token,
        tokenSecret,
        body: query,
      }),
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const d = json?.data;
  if (!d) return null;
  return {
    name: d.name,
    // the default avatar URL is the small "_normal" crop -- ask for the bigger one
    avatar: d.profile_image_url ? d.profile_image_url.replace("_normal", "_200x200") : null,
  };
}
