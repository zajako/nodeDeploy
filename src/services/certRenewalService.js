'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../config/database');
const { generateNginxConfig } = require('./nginxService');

const execFileAsync = promisify(execFile);

// How often to run `certbot renew` (certbot itself only renews certs that are
// within 30 days of expiry, so running frequently is cheap and safe).
const RENEW_INTERVAL_HOURS = Math.max(
  1,
  parseFloat(process.env.CERT_RENEW_INTERVAL_HOURS || '12') || 12
);

// Delay the first run so startup (DB init, nginx config sync) settles first.
const INITIAL_DELAY_MS = 2 * 60 * 1000;

// Warn about certs this close to expiry that certbot could not renew —
// e.g. wildcard certs obtained with --manual, which certbot cannot
// auto-renew and which need a manual DNS-challenge re-run.
const EXPIRY_WARN_DAYS = 14;

// Global (not project-specific) log rows — they show up in the dashboard's
// recent-activity feed via its LEFT JOIN on projects.
async function addLog(type, message) {
  try {
    await query(
      'INSERT INTO deploy_logs (project_id, log_type, message) VALUES (NULL, ?, ?)',
      [type, message]
    );
  } catch (err) {
    console.error('[certRenew] Failed to write log:', err.message);
  }
}

// -------------------------------------------------------------------------
// Run `sudo certbot renew` and reload nginx if anything was renewed.
// Uses the same sudoers entry as tryCertbot (NOPASSWD: /usr/bin/certbot).
// -------------------------------------------------------------------------
let renewInProgress = false;

async function renewCertificates() {
  if (renewInProgress) return;
  renewInProgress = true;

  try {
    console.log('[certRenew] Running certbot renew...');
    let output;
    let failed = false;
    try {
      const { stdout, stderr } = await execFileAsync(
        'sudo', ['certbot', 'renew', '--non-interactive'],
        { timeout: 10 * 60 * 1000 }
      );
      output = [stdout, stderr].filter(Boolean).join('\n');
    } catch (err) {
      failed = true;
      output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    }

    const renewedSomething = /successfully renewed|renewals succeeded/i.test(output);

    if (renewedSomething) {
      // Regenerate + reload so nginx picks up the new cert files (and any
      // lineage directory changes, e.g. domain-0001).
      await generateNginxConfig();
      const renewedLines = output.split('\n')
        .map(l => l.trim())
        .filter(l => /fullchain\.pem/.test(l) && /success/i.test(l));
      await addLog('info',
        `[certbot] Auto-renewal succeeded — nginx reloaded.` +
        (renewedLines.length ? ` Renewed: ${renewedLines.join('; ')}` : ''));
      console.log('[certRenew] Certificates renewed, nginx reloaded.');
    }

    if (failed) {
      // Log only the failure-relevant lines; full renew output can be long.
      const errorLines = output.split('\n')
        .map(l => l.trim())
        .filter(l => /fail|error|problem|could not|manual/i.test(l))
        .slice(0, 15);
      for (const line of errorLines) {
        await addLog('error', `[certbot] renew: ${line}`);
      }
      console.error('[certRenew] certbot renew reported failures — see portal logs.');
    } else if (!renewedSomething) {
      console.log('[certRenew] No certificates due for renewal.');
    }

    await warnAboutExpiringCerts();
  } catch (err) {
    console.error('[certRenew] Unexpected error:', err.message);
  } finally {
    renewInProgress = false;
  }
}

// -------------------------------------------------------------------------
// After a renew pass, check for certs that are still expired or close to
// expiry — these are ones `certbot renew` cannot fix on its own (typically
// wildcard certs obtained with --manual DNS challenges).
// -------------------------------------------------------------------------
async function warnAboutExpiringCerts() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('sudo', ['certbot', 'certificates'],
      { timeout: 2 * 60 * 1000 }));
  } catch (err) {
    console.error('[certRenew] certbot certificates failed:', err.message);
    return;
  }

  // Blocks look like:
  //   Certificate Name: npmdeploy.com-0001
  //     Domains: npmdeploy.com *.npmdeploy.com
  //     Expiry Date: 2026-07-01 12:00:00+00:00 (VALID: 89 days)   <- or (INVALID: EXPIRED)
  const blockRe = /Certificate Name:\s*(\S+)[\s\S]*?Domains:\s*([^\n]+)[\s\S]*?Expiry Date:[^(]*\(([^)]*)\)/g;
  let match;
  while ((match = blockRe.exec(stdout)) !== null) {
    const [, certName, domains, validity] = match;
    const daysMatch = validity.match(/VALID:\s*(\d+)\s*day/i);
    const expired = /INVALID|EXPIRED/i.test(validity);
    const daysLeft = daysMatch ? parseInt(daysMatch[1], 10) : null;

    if (expired || (daysLeft !== null && daysLeft <= EXPIRY_WARN_DAYS)) {
      const state = expired ? 'EXPIRED' : `expires in ${daysLeft} day(s)`;
      const isWildcard = /\*/.test(domains);
      const hint = isWildcard
        ? 'Wildcard certs obtained with `certbot --manual` cannot auto-renew — ' +
          're-run the manual DNS-challenge command, or switch to a certbot DNS ' +
          'plugin (e.g. certbot-dns-cloudflare) so renewals are automatic.'
        : 'Auto-renewal did not fix this cert — check DNS and that port 80 reaches this server, then use Refresh SSL.';
      await addLog('error',
        `[certbot] Certificate "${certName}" (${domains.trim()}) is ${state}. ${hint}`);
      console.error(`[certRenew] Certificate ${certName} is ${state}.`);
    }
  }
}

// -------------------------------------------------------------------------
// Start the background scheduler: first pass shortly after boot, then
// every RENEW_INTERVAL_HOURS.
// -------------------------------------------------------------------------
function startCertRenewalScheduler() {
  setTimeout(() => { renewCertificates(); }, INITIAL_DELAY_MS).unref();
  setInterval(() => { renewCertificates(); }, RENEW_INTERVAL_HOURS * 3600 * 1000).unref();
  console.log(`[certRenew] Auto-renewal scheduler started (every ${RENEW_INTERVAL_HOURS}h, first run in ${INITIAL_DELAY_MS / 60000} min)`);
}

module.exports = { startCertRenewalScheduler, renewCertificates };
