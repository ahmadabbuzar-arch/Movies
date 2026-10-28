# Provider configurations

Put one `*.json` file per provider (or one file with an array / `{"providers":[...]}`) in this folder, push, redeploy.
No change to `index.html` is needed. Format and examples: `/PROVIDERS.md`.
This folder is under `api/_...`, so Vercel does not publish it as a URL. Check with `curl -I https://<site>/api/_provider-configs/<file>.json` (must not return 200).
Never put tokens, cookies or API keys in these files: use `"${env:PROVIDER_NAME}"` and set the value in Vercel > Settings > Environment Variables.
