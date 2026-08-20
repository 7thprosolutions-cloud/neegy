// Validates the OAuth 1.0a signer against the canonical test vector published
// in X's own signing docs. Run: node server/_selftest.mjs
import { authHeader } from "./oauth1.mjs";

const header = authHeader({
  method: "POST",
  url: "https://api.twitter.com/1.1/statuses/update.json",
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  extra: {
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    oauth_timestamp: "1318622958",
  },
  body: {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    include_entities: "true",
  },
});

const got = decodeURIComponent(header.match(/oauth_signature="([^"]+)"/)[1]);
const want = "hCtSmYh+iHYCEqBWrE7C7hYmtUk=";
console.log("signature:", got);
console.log("expected :", want);
console.log(got === want ? "PASS" : "FAIL");
process.exit(got === want ? 0 : 1);
