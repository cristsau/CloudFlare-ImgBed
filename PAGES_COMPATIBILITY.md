# Cloudflare Pages compatibility

This fork is deployed through the existing Cloudflare Pages Git integration.
The project currently publishes the repository root, while upstream v2.7.5
stores its static site in `frontend-dist`.

Until the Pages dashboard output directory is changed to `/frontend-dist`, the
contents of `frontend-dist` are mirrored at the repository root. The
`CloudFlare-ImgBed checks` workflow verifies that both copies stay identical.

The pre-upgrade source is retained on the
`backup/pre-upgrade-20260731` branch. Automatic upstream sync and unrelated
Worker/Docker publishing workflows are intentionally disabled for this Pages
deployment.
