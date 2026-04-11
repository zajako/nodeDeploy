# NodeDeploy

A self-hosted Node.js application deployment portal. Point it at a GitHub repository, and NodeDeploy clones the code, installs dependencies, starts the process under PM2, and wires up an nginx subdomain — all from a web UI. Push to your branch and it redeploys automatically via GitHub webhooks.

---

## Features

- **One-click deploys** — paste a GitHub repo URL, choose a branch, and deploy
- **Subdomain routing** — each app gets its own subdomain (`myapp.yourdomain.com`) with no manual nginx editing
- **Auto-deploy on push** — GitHub webhooks trigger a pull, rebuild, and PM2 restart on every push to the tracked branch
- **PM2 process management** — start, stop, restart, and monitor apps from the UI
- **GitHub OAuth** — admin access restricted to a configurable list of GitHub usernames
- **MySQL database linking** — attach a database to a project and credentials are injected into the app's `.env` automatically
- **Custom environment variables** — set arbitrary key/value pairs per project
- **Monorepo / subdirectory support** — use `--prefix <subdir>` in the start command to target a subdirectory
- **Deploy logs** — live-refreshing log view per project with auto/manual toggle
- **Wildcard TLS** — serve all subdomains over HTTPS with a single Let's Encrypt wildcard certificate

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 18+ |
| npm | 8+ |
| MySQL | 5.7+ or 8.x |
| nginx | 1.14+ (with `ngx_http_sub_module`) |
| PM2 | 5.x (installed globally) |
| certbot | any recent version |
| git | 2.x |

The server must be publicly reachable so GitHub can deliver webhook payloads.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/zajako/nodedeploy.git
cd nodedeploy
npm install
```

### 2. Create the MySQL database

```bash
mysql -u root -p < sql/setup.sql
```

Then create the application user (edit the password first):

```sql
CREATE USER 'nodedeploy_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON nodedeploy.* TO 'nodedeploy_user'@'localhost';
FLUSH PRIVILEGES;
```

### 3. Create a GitHub OAuth App

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set **Homepage URL** to `https://yourdomain.com`
3. Set **Authorization callback URL** to `https://yourdomain.com/auth/github/callback`
4. Copy the **Client ID** and generate a **Client Secret**

The OAuth app needs the following scopes to be requested at login (already configured in the app): `user:email`, `repo`, `admin:repo_hook`.

### 4. Configure environment variables

```bash
cp .env.example .env
nano .env
```

```env
# Application
PORT=8080
NODE_ENV=production
SESSION_SECRET=change-this-to-a-long-random-string
APP_URL=https://yourdomain.com
COOKIE_SECURE=false          # set to true after HTTPS is working

# GitHub OAuth
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_CALLBACK_URL=https://yourdomain.com/auth/github/callback

# Admin access (comma-separated GitHub usernames)
ADMIN_GITHUB_USERNAMES=yourgithubusername

# MySQL (portal database)
DB_HOST=localhost
DB_PORT=3306
DB_NAME=nodedeploy
DB_USER=nodedeploy_user
DB_PASSWORD=your_password

# Deployment
DEPLOY_BASE_PATH=/var/www/nodeapps   # must be outside the nodedeploy directory
STARTING_PORT=4000

# Nginx
NGINX_PROJECTS_CONF=/home/youruser/nodedeploy/nginx/projects.conf
BASE_DOMAIN=yourdomain.com

# Wildcard TLS cert (fill in after step 7)
WILDCARD_CERT_PATH=/etc/letsencrypt/live/yourdomain.com-0001
```

> **COOKIE_SECURE**: Set to `false` until HTTPS is working end-to-end, otherwise the browser will silently drop the session cookie and you will be stuck in a login redirect loop.

### 5. Install PM2 globally

```bash
sudo npm install -g pm2
```

### 6. Configure nginx

#### Add the map block to `/etc/nginx/nginx.conf`

Inside the `http { }` block, add (skip if already present):

```nginx
map $http_upgrade $connection_upgrade {
    default  upgrade;
    ''       close;
}
```

#### Install the main site config

```bash
sudo cp nginx/npmdeploy.com.conf /etc/nginx/sites-available/yourdomain.com
# Edit server_name and cert paths to match your domain
sudo nano /etc/nginx/sites-available/yourdomain.com
sudo ln -s /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/
```

#### Symlink the auto-generated projects config

```bash
sudo ln -sf /home/youruser/nodedeploy/nginx/projects.conf \
            /etc/nginx/sites-enabled/nodedeploy-projects.conf
```

This file is regenerated automatically whenever a project is added, redeployed, or deleted. nginx is reloaded after each change.

#### Grant passwordless nginx reload

```bash
sudo visudo
```

Add this line (replace `youruser`):

```
youruser ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload
```

#### Bootstrap HTTP-only config first

Before certbot runs, make sure nginx only serves HTTP (no SSL directives yet) and test:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Obtain TLS certificates

#### Main domain (HTTP challenge — simple)

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

#### Wildcard cert for project subdomains (DNS challenge — required for wildcards)

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d yourdomain.com -d '*.yourdomain.com'
```

Certbot will pause and display a TXT record to add:

```
Please deploy a DNS TXT record under the name:
_acme-challenge.yourdomain.com
with the following value: <token>
```

Add the TXT record at your DNS provider, wait ~60 seconds, then press Enter. Note the path certbot prints — it may be `yourdomain.com-0001` rather than `yourdomain.com`. Set `WILDCARD_CERT_PATH` in `.env` to that exact path.

Once both certs are in place, set `COOKIE_SECURE=true` in `.env`.

### 8. Start the portal with PM2

```bash
pm2 start src/app.js --name nodedeploy
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

### 9. Final nginx reload

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Navigate to `https://yourdomain.com` and sign in with GitHub.

---

## Deploying your first app

1. Sign in and go to **Projects → New Project**
2. Enter the GitHub repository URL (public or private — the OAuth token handles auth)
3. Set the branch, start command, and optionally a build command
4. Optionally link a MySQL database — credentials are written to the app's `.env`
5. Click **Deploy**

The portal will clone the repo, run `npm install`, run the build command if set, start the process with PM2, generate an nginx server block at `appname.yourdomain.com`, and register a GitHub webhook for auto-deploy.

### Start / Build commands

| Use case | Start command | Build command |
|---|---|---|
| Standard app | `npm start` | _(blank)_ |
| Custom entry | `node server.js` | _(blank)_ |
| With build step | `npm start` | `npm run build` |
| Subdirectory app | `npm start --prefix game` | `npm run build --prefix game` |

The `--prefix <subdir>` flag in the start command is detected automatically — `npm install` and the build command will both run in that subdirectory.

### Auto-deploy on push

After the initial deploy, a GitHub webhook is created automatically. Every push to the tracked branch triggers:

1. `git fetch` + `git reset --hard origin/<branch>`
2. `npm install`
3. Build command (if configured)
4. `pm2 restart <appname>`

If the webhook was not created (check the **GitHub Webhook** card on the project page), click **Register Webhook** to register it without redeploying.

---

## Project structure

```
nodedeploy/
├── nginx/
│   ├── npmdeploy.com.conf   # Site config template (copy to sites-available)
│   └── projects.conf        # Auto-generated per-project server blocks
├── sql/
│   └── setup.sql            # Database schema + setup instructions
├── src/
│   ├── app.js               # Express app entry point
│   ├── config/
│   │   ├── database.js      # MySQL connection pool
│   │   └── passport.js      # GitHub OAuth strategy
│   ├── middleware/
│   │   └── auth.js          # isAuthenticated / isAdmin guards
│   ├── routes/
│   │   ├── admin.js         # All /admin/* routes
│   │   ├── auth.js          # GitHub OAuth flow
│   │   └── webhook.js       # POST /webhook/:project (GitHub push events)
│   ├── services/
│   │   ├── deployService.js # Clone, build, PM2, env file, webhook setup
│   │   └── nginxService.js  # nginx config generation and reload
│   └── views/               # EJS templates (Bootstrap 5 dark theme)
├── .env.example
└── package.json
```

---

## Environment variables reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Port the portal listens on |
| `NODE_ENV` | No | `development` | Set to `production` in production |
| `SESSION_SECRET` | **Yes** | — | Long random string for session signing |
| `APP_URL` | **Yes** | — | Public URL used for webhook callback registration |
| `COOKIE_SECURE` | No | `false` | Set to `true` once HTTPS is working |
| `GITHUB_CLIENT_ID` | **Yes** | — | OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | **Yes** | — | OAuth App client secret |
| `GITHUB_CALLBACK_URL` | **Yes** | — | Must match the OAuth App setting exactly |
| `ADMIN_GITHUB_USERNAMES` | **Yes** | — | Comma-separated GitHub usernames allowed admin access |
| `DB_HOST` | No | `localhost` | MySQL host |
| `DB_PORT` | No | `3306` | MySQL port |
| `DB_NAME` | **Yes** | — | Portal database name |
| `DB_USER` | **Yes** | — | Portal database user |
| `DB_PASSWORD` | **Yes** | — | Portal database password |
| `DEPLOY_BASE_PATH` | No | `/var/www/nodeapps` | Directory where app code is cloned |
| `STARTING_PORT` | No | `4000` | First port allocated to deployed apps |
| `NGINX_PROJECTS_CONF` | No | `nginx/projects.conf` | Path to the auto-generated nginx include file |
| `BASE_DOMAIN` | No | `npmdeploy.com` | Base domain for project subdomains |
| `WILDCARD_CERT_PATH` | No | — | Full path to wildcard cert directory (e.g. `/etc/letsencrypt/live/yourdomain.com-0001`) |
| `WILDCARD_CERT_DOMAIN` | No | — | Alternative to `WILDCARD_CERT_PATH` — derives path as `/etc/letsencrypt/live/<domain>` |

---

## Updating the portal

```bash
cd ~/nodedeploy
git pull
npm install
pm2 restart nodedeploy
```

nginx config is regenerated automatically on startup — no manual nginx changes needed after updates.

---

## Troubleshooting

**Stuck in login redirect loop**
The session cookie is being rejected. Ensure `COOKIE_SECURE=false` if the site is not yet serving HTTPS, or that `COOKIE_SECURE=true` with a valid TLS cert and `APP_URL` set to `https://...`.

**`nginx -t` fails after symlinking `projects.conf`**
The file contains old location-block content from before the subdomain migration. Clear it and restart the portal:
```bash
echo '# Auto-generated by NodeDeploy' > ~/nodedeploy/nginx/projects.conf
sudo nginx -t && sudo systemctl reload nginx
pm2 restart nodedeploy
```

**Deploy fails: `package.json not found`**
The app code lives in a subdirectory. Set the start command to `npm start --prefix <subdir>` (e.g. `npm start --prefix game`) and redeploy.

**Webhook not triggering auto-deploy**
Open the project page. If the **GitHub Webhook** card shows no Webhook ID, click **Register Webhook**. Also verify that `APP_URL` in `.env` is the publicly reachable URL of the portal.

**`nginx -s reload` permission denied**
The sudoers entry is missing. Run `sudo visudo` and add:
```
youruser ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload
```

**Project subdomain shows certificate error**
The wildcard cert does not yet cover `*.yourdomain.com`. Run the `certbot certonly --manual --preferred-challenges dns` command in step 7, then set `WILDCARD_CERT_PATH` in `.env` and restart the portal.

---

## License

MIT
