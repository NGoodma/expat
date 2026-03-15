# Deploy backend

This backend is a long-running Node.js + Socket.IO server. For a cheap and predictable setup, use a small VPS instead of a free PaaS.

## Recommended baseline

- Provider type: small VPS with fixed monthly price.
- Practical target: 1 vCPU, 2 GB RAM, 20 GB SSD.
- OS: Ubuntu 24.04 LTS.
- Runtime: Docker Engine + Docker Compose.

For this project, that is enough for a small number of simultaneous rooms and avoids PaaS sleep or trial limits.

## Good low-cost options

- Hetzner Cloud: usually one of the best price-to-stability options.
- Contabo VPS: often slightly cheaper, but operational quality can be less consistent.
- DigitalOcean or Vultr: simpler UX, but usually more expensive for the same specs.

If you want the cheapest sane default, start with Hetzner Cloud.

## Deploy on a VPS

1. Create a VPS with Ubuntu 24.04.
2. Point a domain or subdomain to the server IP.
3. Install Docker and Docker Compose.
4. Copy the repository to the server.
5. In the `corporat-server` folder, create a `.env` file.
6. Start the service with `docker compose up -d --build`.
7. Put Nginx or Caddy in front of the app for HTTPS.
8. Verify `https://your-domain/health` returns `{ "ok": true }`.

## Example .env

`PORT=8081`

`CLIENT_ORIGIN=https://ngoodma.github.io`

If you use a custom frontend domain later, add it too:

`CLIENT_ORIGIN=https://ngoodma.github.io,https://your-frontend.example.com`

## Frontend update

After the backend is live, update the GitHub Actions secret `VITE_WEBSOCKET_URL` to the new backend URL, then redeploy the frontend.

Example:

`https://your-backend.example.com`