'use strict';

const fs   = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../config/database');

const execFileAsync = promisify(execFile);

const NGINX_DIR = path.join(__dirname, '..', '..', 'nginx');

const NGINX_PROJECTS_CONF = process.env.NGINX_PROJECTS_CONF ||
  path.join(NGINX_DIR, 'projects.conf');

const BASE_DOMAIN = process.env.BASE_DOMAIN || 'npmdeploy.com';

const WILDCARD_CERT_DOMAIN = process.env.WILDCARD_CERT_DOMAIN || '';
const WILDCARD_CERT_PATH = process.env.WILDCARD_CERT_PATH ||
  (WILDCARD_CERT_DOMAIN ? `/etc/letsencrypt/live/${WILDCARD_CERT_DOMAIN}` : '');

// -------------------------------------------------------------------------
// Shared proxy location block used by both subdomain and custom-domain blocks
// -------------------------------------------------------------------------
function proxyLocation(port) {
  return `    location / {
        proxy_pass            http://127.0.0.1:${port};
        proxy_http_version    1.1;
        proxy_set_header      Upgrade           $http_upgrade;
        proxy_set_header      Connection        "upgrade";
        proxy_set_header      Host              $host;
        proxy_set_header      X-Real-IP         $remote_addr;
        proxy_set_header      X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto $scheme;
        proxy_read_timeout    120s;
        proxy_connect_timeout 10s;
    }`;
}

// -------------------------------------------------------------------------
// Build a server block for the auto-assigned subdomain: <name>.<BASE_DOMAIN>
// -------------------------------------------------------------------------
function serverBlock(project) {
  const { name, port } = project;
  const serverName = `${name}.${BASE_DOMAIN}`;
  const location = proxyLocation(port);

  if (WILDCARD_CERT_PATH) {
    return `
# ---- ${name} (port ${port}) ----
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${serverName};
    ssl_certificate     ${WILDCARD_CERT_PATH}/fullchain.pem;
    ssl_certificate_key ${WILDCARD_CERT_PATH}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    client_max_body_size 50m;
${location}
}`;
  }

  return `
# ---- ${name} (port ${port}) ----
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};
    client_max_body_size 50m;
${location}
}`;
}

// -------------------------------------------------------------------------
// Build an additional server block for a project's custom domain (if set).
// Covers both bare domain and www. subdomain.
// Uses the project-specific cert if certbot has already run, otherwise
// generates an HTTP-only block that includes the ACME challenge location
// so certbot can obtain the cert without downtime.
// -------------------------------------------------------------------------
async function customDomainBlock(project) {
  const { name, port, custom_domain } = project;
  if (!custom_domain) return '';

  const serverName = `${custom_domain} www.${custom_domain}`;
  const certDir    = `/etc/letsencrypt/live/${custom_domain}`;
  const location   = proxyLocation(port);

  let hasCert = false;
  try {
    await fs.access(`${certDir}/fullchain.pem`);
    hasCert = true;
  } catch { /* cert not yet obtained */ }

  if (hasCert) {
    return `
# ---- ${name} custom domain: ${custom_domain} ----
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${serverName};
    ssl_certificate     ${certDir}/fullchain.pem;
    ssl_certificate_key ${certDir}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    client_max_body_size 50m;
${location}
}`;
  }

  // No cert yet — HTTP only with ACME challenge location so certbot can run
  return `
# ---- ${name} custom domain: ${custom_domain} (HTTP – run certbot to enable HTTPS) ----
server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};
    # ACME challenge for certbot
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    client_max_body_size 50m;
${location}
}`;
}

// -------------------------------------------------------------------------
// Attempt to obtain a cert for a custom domain via certbot --webroot.
// Requires CERTBOT_EMAIL env var and sudo certbot in sudoers.
// Returns { success, output } where output is the combined certbot stdout/stderr.
// -------------------------------------------------------------------------
async function tryCertbot(domain) {
  const email = process.env.CERTBOT_EMAIL;
  if (!email) {
    const msg = 'CERTBOT_EMAIL is not set in .env — certbot skipped.';
    console.log(`[nginx] ${msg}`);
    return { success: false, output: msg };
  }
  try {
    const { stdout, stderr } = await execFileAsync('sudo', [
      'certbot', 'certonly', '--webroot',
      '-w', '/var/www/html',
      '-d', domain,
      '-d', `www.${domain}`,
      '--non-interactive', '--agree-tos',
      '-m', email
    ]);
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    console.log(`[nginx] certbot succeeded for ${domain}`);
    return { success: true, output };
  } catch (err) {
    // execFile rejects with an Error that has .stdout and .stderr attached
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
    console.error(`[nginx] certbot failed for ${domain}:`, output);
    return { success: false, output };
  }
}

// -------------------------------------------------------------------------
// Regenerate projects.conf from the database and reload nginx
// -------------------------------------------------------------------------
async function generateNginxConfig() {
  try {
    const projects = await query(`SELECT name, port, custom_domain FROM projects ORDER BY name`);

    const header = [
      `# Auto-generated by NodeDeploy – do not edit manually`,
      `# Updated: ${new Date().toISOString()}`,
      `# Projects are served at <name>.${BASE_DOMAIN} (+ optional custom domain)`,
      `#`,
      `# ONE-TIME SETUP: symlink this file into sites-enabled:`,
      `#   sudo ln -sf ${NGINX_PROJECTS_CONF} /etc/nginx/sites-enabled/nodedeploy-projects.conf`,
      ``,
    ].join('\n');

    let body;
    if (projects.length) {
      const blocks = await Promise.all(
        projects.map(async (p) => serverBlock(p) + await customDomainBlock(p))
      );
      body = blocks.join('\n');
    } else {
      body = '# No projects registered yet\n';
    }

    await fs.writeFile(NGINX_PROJECTS_CONF, header + body + '\n', 'utf8');
    console.log(`[nginx] Wrote ${projects.length} project server block(s) to ${NGINX_PROJECTS_CONF}`);

    await reloadNginx();
    return true;
  } catch (err) {
    console.error('[nginx] generateNginxConfig error:', err.message);
    return false;
  }
}

// -------------------------------------------------------------------------
// Reload nginx (requires sudoers entry – see README)
// -------------------------------------------------------------------------
async function reloadNginx() {
  try {
    await execFileAsync('sudo', ['nginx', '-s', 'reload']);
    console.log('[nginx] Reloaded successfully');
  } catch (err) {
    console.error('[nginx] Reload failed:', err.message);
    console.error('[nginx] Add this to /etc/sudoers (visudo):');
    console.error('[nginx]   %s ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload',
      process.env.USER || 'zajako');
  }
}

// -------------------------------------------------------------------------
// Create empty config file on first run so nginx -t never fails
// -------------------------------------------------------------------------
async function ensureConfExists() {
  await fs.mkdir(NGINX_DIR, { recursive: true });

  try {
    await fs.access(NGINX_PROJECTS_CONF);
  } catch {
    await fs.writeFile(NGINX_PROJECTS_CONF, '# Auto-generated by NodeDeploy\n', 'utf8');
    console.log('[nginx] Created', NGINX_PROJECTS_CONF);
  }
}

module.exports = { generateNginxConfig, reloadNginx, ensureConfExists, tryCertbot };
