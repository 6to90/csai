// Cloudflare Email Worker: forwards each inbound message, as raw RFC 5322, to CSAI's signed webhook.
// Setup (see ARCHITECTURE §6.9): Email Routing -> route the support address to this Worker; set Worker secrets
//   CSAI_WEBHOOK_URL = https://<app>/api/v1/webhooks/email/<channel id>     CSAI_WEBHOOK_SECRET = <secret shown once when the channel was created>
// NOTE: signing logic is verified in tests/unit/worker.test.ts under Node; it has NOT been run on Cloudflare's runtime.
const worker = {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.CSAI_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const prefix = new TextEncoder().encode(`${ts}.`);
    const data = new Uint8Array(prefix.length + raw.byteLength); data.set(prefix); data.set(new Uint8Array(raw), prefix.length);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, data))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await fetch(env.CSAI_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'message/rfc822', 'x-signature-timestamp': ts, 'x-signature': sig }, body: raw });
    if (!res.ok) throw new Error(`csai webhook ${res.status}`);   // surfaces as a delivery failure so the message is not silently lost
  },
};
export default worker;
