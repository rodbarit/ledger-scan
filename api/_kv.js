import { createClient } from "@vercel/kv";

export const kv = createClient({
  url: process.env.kv_KV_REST_API_URL,
  token: process.env.kv_KV_REST_API_TOKEN,
});
