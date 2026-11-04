# Railway test setup

This is an experimental single-operator voice-quality test based on VoxDock. It runs the bridge, its simulated context backend, and the patched WaCalls service inside one Railway container. WaCalls and the backend listen on loopback only. Real WhatsApp calling, Railway UDP networking, build and audio quality have not been verified for this deployment.

1. Deploy this GitHub repository as a Railway service. The root `Dockerfile` is configured for Railway; no Dockerfile-path variable is needed.
2. Add a persistent volume mounted at `/data`. Use exactly one replica and never run another instance using this WhatsApp session.
3. Set the secret variable `OPENAI_API_KEY` in Railway. Generate a public domain for the service; Railway supplies `RAILWAY_PUBLIC_DOMAIN`. If needed set `VOXDOCK_PUBLIC_ORIGIN` to the exact `https://...` origin with no trailing slash. Redeploy after setting these values. The app listens on Railway's `PORT`.
4. Open `https://<your-domain>/console/`. Obtain the initial private admin credentials using `railway ssh` and `cat /data/bootstrap-credentials.txt`; change the password in Settings. Do not share the credentials, QR code, or volume contents.
5. In Connections, configure WhatsApp: link the calling account with its QR code, then verify the other number using the console's receiving-account procedure. In Settings configure/verify Live and backend settings, enable calling, and save. GPT-Live uses the API key already supplied. Retain the local test backend's generated credential files. The default instruction asks the agent to follow the person's language.
6. From Railway SSH, run `node scripts/call-test.mjs`. This starts a real call to the verified WhatsApp recipient and can incur OpenAI charges. Hang up from the phone or use the VoxDock console. The default maximum is five minutes per call and 20 minutes of Live time per day. Configure lower limits in Settings if desired.

The single `/data` volume holds credentials, SQLite databases, and WhatsApp session state. Deleting it requires pairing again. Service logs and console readiness do not prove the other person heard audio. Test both directions and interruptions on a real call. If a call outcome becomes uncertain, follow `docs/state-and-recovery.md`; do not repeatedly redial.
