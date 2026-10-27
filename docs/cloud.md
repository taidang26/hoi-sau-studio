# Dashboard on the cloud

```
hoisau.dangtrantai.com         Firebase Hosting   public site + media for Instagram/Threads
demo.hoisau.dangtrantai.com    → Cloud Run hoisau-demo    sample data, posts nothing, open to anyone
admin.hoisau.dangtrantai.com   → Cloud Run hoisau-admin   real data, DASHBOARD_PASSWORD
                                    └─ bucket gs://testmsbmusic-ai-hoisau
                                       data/ episodes/ output/ characters/ series/ .env
```

Firebase project `testmsbmusic-ai` on the Blaze plan, region `asia-southeast1`.
Firebase Hosting forwards each domain to its Cloud Run service; it only passes the
`__session` cookie, which is the one the login uses.

## Commands

```bash
npm run cloud -- demo            # build, deploy hoisau-demo, then the demo Hosting site
npm run cloud -- seed            # once: copy data/ episodes/ output/ characters/ series/ to the bucket
npm run cloud -- admin           # needs DASHBOARD_PASSWORD in .env; uploads .env, deploys hoisau-admin
npm run cloud -- env             # after a token changes on this machine
npm run cloud -- down demo       # remove a service after the contest
```

The container is the `Dockerfile` at the repo root. `deploy/start.sh` links the
writable folders and `.env` into the bucket when `STORE_DIR` is set. Run it locally:

```bash
docker build -t hoisau-dashboard .
docker run -p 8080:8080 hoisau-dashboard --demo
```

The admin runs one instance with CPU always on while it is up, because episodes
are drawn in the background after the request returns. It scales to zero when idle.
When the bucket is the source of truth, run the CLIs against it, not against the
local folders, or copy back with `gcloud storage cp -r gs://testmsbmusic-ai-hoisau/data .`.
