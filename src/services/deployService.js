'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const dotenv = require('dotenv');
const simpleGit = require('simple-git');
const pm2 = require('pm2');
const { v4: uuidv4 } = require('uuid');
const { Octokit } = require('octokit');
const { query } = require('../config/database');
const { generateNginxConfig } = require('./nginxService');

const execFileAsync = promisify(execFile);

const DEPLOY_BASE_PATH = process.env.DEPLOY_BASE_PATH || '/var/www/nodeapps';
const STARTING_PORT = parseInt(process.env.STARTING_PORT || '4000', 10);
const APP_URL = process.env.APP_URL || 'https://npmdeploy.com';

// -------------------------------------------------------------------------
// PM2 helpers
// -------------------------------------------------------------------------
function pm2Connect() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

function pm2Disconnect() {
  return new Promise((resolve) => {
    pm2.disconnect(resolve);
  });
}

function pm2Start(options) {
  return new Promise((resolve, reject) => {
    pm2.start(options, (err, apps) => (err ? reject(err) : resolve(apps)));
  });
}

function pm2Stop(name) {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2Restart(name) {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => (err ? reject(err) : resolve()));
  });
}

function pm2Delete(name) {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => (err ? reject(err) : resolve()));
  });
}

// -------------------------------------------------------------------------
// Logging helper
// -------------------------------------------------------------------------
async function addLog(projectId, logType, message) {
  try {
    await query(
      `INSERT INTO deploy_logs (project_id, log_type, message) VALUES (?, ?, ?)`,
      [projectId, logType, message]
    );
  } catch (err) {
    console.error('Failed to write deploy log:', err.message);
  }
}

// -------------------------------------------------------------------------
// Parse GitHub repo URL
// Returns { owner, repo } or null
// -------------------------------------------------------------------------
function parseRepoUrl(repoUrl) {
  if (!repoUrl) return null;
  let url = repoUrl.trim();

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?(?:\/.*)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

// -------------------------------------------------------------------------
// Build authenticated clone URL
// -------------------------------------------------------------------------
function buildAuthCloneUrl(parsed, accessToken) {
  return `https://x-access-token:${accessToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
}

// -------------------------------------------------------------------------
// Get next available port
// -------------------------------------------------------------------------
async function getNextPort() {
  const rows = await query('SELECT MAX(port) as maxPort FROM projects');
  const maxPort = rows[0] && rows[0].maxPort ? rows[0].maxPort : null;
  if (maxPort === null) {
    return STARTING_PORT;
  }
  return maxPort + 1;
}

// -------------------------------------------------------------------------
// Generate .env file content and write it to the deploy directory
// -------------------------------------------------------------------------
async function generateEnvFile(project, dbCredentials = null, customEnvVars = {}) {
  const lines = [];

  // Always inject PORT so the app listens on the right port
  lines.push(`PORT=${project.port}`);
  lines.push(`NODE_ENV=production`);

  // DB credentials
  if (dbCredentials) {
    lines.push(`DB_HOST=${dbCredentials.db_host || 'localhost'}`);
    lines.push(`DB_PORT=${dbCredentials.db_port || 3306}`);
    lines.push(`DB_NAME=${dbCredentials.db_name}`);
    lines.push(`DB_USER=${dbCredentials.db_user}`);
    lines.push(`DB_PASSWORD=${dbCredentials.db_password}`);
  }

  // Custom env vars
  for (const [key, value] of Object.entries(customEnvVars)) {
    if (key) {
      lines.push(`${key}=${value}`);
    }
  }

  const envContent = lines.join('\n') + '\n';
  const envPath = path.join(project.deploy_path, '.env');
  await fs.writeFile(envPath, envContent, 'utf8');

  return envPath;
}

// -------------------------------------------------------------------------
// Read the project's generated .env file and return it as a plain object
// so we can pass all vars directly to PM2 (avoiding parent-env bleed-through).
// -------------------------------------------------------------------------
async function readProjectEnv(project) {
  try {
    const content = await fs.readFile(path.join(project.deploy_path, '.env'), 'utf8');
    return dotenv.parse(content);
  } catch {
    return {};
  }
}

// -------------------------------------------------------------------------
// Detect --prefix <subdir> in the start command so npm install and the
// build command run in the same subdirectory (monorepo / subdir apps).
// e.g. start_command = "npm start --prefix game"  →  subdir = "game"
// -------------------------------------------------------------------------
function getSubdir(project) {
  const m = (project.start_command || '').match(/--prefix\s+(\S+)/);
  return m ? m[1] : null;
}

// -------------------------------------------------------------------------
// Run npm install (and optional build command) in deploy directory
// -------------------------------------------------------------------------
async function runInstallAndBuild(project) {
  const subdir = getSubdir(project);
  const installArgs = ['install', '--production=false'];
  if (subdir) installArgs.push('--prefix', subdir);

  const installLabel = subdir ? `npm install --prefix ${subdir}` : 'npm install';
  await addLog(project.id, 'deploy', `Running ${installLabel}...`);
  await execFileAsync('npm', installArgs, {
    cwd: project.deploy_path,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 5 * 60 * 1000 // 5 min
  });
  await addLog(project.id, 'deploy', 'npm install complete.');

  if (project.build_command) {
    await addLog(project.id, 'deploy', `Running build command: ${project.build_command}`);
    const parts = project.build_command.split(' ');
    const buildCwd = subdir ? path.join(project.deploy_path, subdir) : project.deploy_path;
    await execFileAsync(parts[0], parts.slice(1), {
      cwd: buildCwd,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 10 * 60 * 1000
    });
    await addLog(project.id, 'deploy', 'Build command complete.');
  }
}

// -------------------------------------------------------------------------
// Setup GitHub webhook via Octokit
// -------------------------------------------------------------------------
async function setupGithubWebhook(project, accessToken) {
  try {
    const parsed = parseRepoUrl(project.repo_url);
    if (!parsed) {
      throw new Error('Could not parse repo URL for webhook setup');
    }

    const octokit = new Octokit({ auth: accessToken });
    const secret = uuidv4();
    const webhookUrl = `${APP_URL}/webhook/${project.name}`;

    const response = await octokit.rest.repos.createWebhook({
      owner: parsed.owner,
      repo: parsed.repo,
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0'
      },
      events: ['push'],
      active: true
    });

    const webhookId = String(response.data.id);

    await query(
      `UPDATE projects SET webhook_secret = ?, webhook_id = ? WHERE id = ?`,
      [secret, webhookId, project.id]
    );

    await addLog(project.id, 'info', `GitHub webhook created (id: ${webhookId}) for ${webhookUrl}`);
    return { secret, webhookId };
  } catch (err) {
    await addLog(project.id, 'error', `Failed to create GitHub webhook: ${err.message}`);
    // Don't throw — webhook failure shouldn't abort the whole deploy
  }
}

// -------------------------------------------------------------------------
// deployProject — full fresh deploy
// -------------------------------------------------------------------------
async function deployProject(project, accessToken, dbCredentials = null, customEnvVars = {}) {
  await addLog(project.id, 'deploy', `Starting fresh deploy for project "${project.name}"...`);

  try {
    // 1. Ensure deploy directory exists
    await fs.mkdir(project.deploy_path, { recursive: true });
    await addLog(project.id, 'deploy', `Deploy path ready: ${project.deploy_path}`);

    // 2. Clone the repo
    const parsed = parseRepoUrl(project.repo_url);
    if (!parsed) {
      throw new Error(`Cannot parse repo URL: ${project.repo_url}`);
    }

    const cloneUrl = buildAuthCloneUrl(parsed, accessToken);
    await addLog(project.id, 'deploy', `Cloning ${parsed.owner}/${parsed.repo}...`);

    // Check if directory already has git repo (re-deploy scenario)
    let isGitRepo = false;
    try {
      await fs.access(path.join(project.deploy_path, '.git'));
      isGitRepo = true;
    } catch {
      isGitRepo = false;
    }

    const git = simpleGit(project.deploy_path);

    if (isGitRepo) {
      await addLog(project.id, 'deploy', 'Existing git repo found, fetching latest...');
      await git.remote(['set-url', 'origin', cloneUrl]);
      await git.fetch('origin');
      await git.reset(['--hard', `origin/${project.branch}`]);
    } else {
      await simpleGit().clone(cloneUrl, project.deploy_path, [
        '--branch', project.branch,
        '--depth', '50'
      ]);
    }

    // 3. Ensure correct branch is checked out (matters for re-deploy case;
    //    fresh clones already land on the right branch via --branch above)
    const gitInDir = simpleGit(project.deploy_path);
    try {
      // Try local checkout first, then track remote if branch not local yet
      await gitInDir.checkout(project.branch);
    } catch {
      await gitInDir.checkoutBranch(project.branch, `origin/${project.branch}`);
    }
    await addLog(project.id, 'deploy', `Checked out branch: ${project.branch}`);

    // 4. Write .env file
    await generateEnvFile(project, dbCredentials, customEnvVars);
    await addLog(project.id, 'deploy', '.env file written.');

    // 5. npm install + optional build
    await runInstallAndBuild(project);

    // 6. Start with PM2
    await addLog(project.id, 'deploy', 'Starting application with PM2...');
    await pm2Connect();
    try {
      // Try to delete existing process first (ignore errors)
      await pm2Delete(project.name).catch(() => {});

      const startScript = project.start_command && project.start_command !== 'npm start'
        ? project.start_command
        : 'npm';

      const startArgs = project.start_command && project.start_command !== 'npm start'
        ? undefined
        : ['start'];

      const projectEnv = await readProjectEnv(project);
      await pm2Start({
        name: project.name,
        script: startScript,
        args: startArgs,
        cwd: project.deploy_path,
        env: { NODE_ENV: 'production', PORT: String(project.port), ...projectEnv },
        watch: false,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        log_date_format: 'YYYY-MM-DD HH:mm:ss'
      });
    } finally {
      await pm2Disconnect();
    }
    await addLog(project.id, 'deploy', 'Application started with PM2.');

    // 7. Update project status in DB
    await query(
      `UPDATE projects SET status = 'active', last_deployed = CURRENT_TIMESTAMP WHERE id = ?`,
      [project.id]
    );
    await addLog(project.id, 'deploy', `Deploy complete! Running on port ${project.port}.`);

    // 8. Regenerate nginx project location blocks
    await generateNginxConfig();

    // 9. Setup GitHub webhook (async, non-blocking)
    await setupGithubWebhook(project, accessToken);
  } catch (err) {
    await query(`UPDATE projects SET status = 'error' WHERE id = ?`, [project.id]);
    await addLog(project.id, 'error', `Deploy failed: ${err.message}`);
    throw err;
  }
}

// -------------------------------------------------------------------------
// pullAndRedeploy — webhook / manual re-deploy
// -------------------------------------------------------------------------
async function pullAndRedeploy(project) {
  await addLog(project.id, 'deploy', 'Pull and redeploy triggered...');

  try {
    await query(`UPDATE projects SET status = 'deploying' WHERE id = ?`, [project.id]);

    // Get access token from the user who created the project
    const users = await query(
      `SELECT u.access_token FROM users u
       JOIN projects p ON p.created_by = u.id
       WHERE p.id = ?`,
      [project.id]
    );
    const accessToken = users[0] && users[0].access_token ? users[0].access_token : null;

    // If the deploy directory is missing (manually deleted, first deploy failed,
    // etc.) fall back to a full fresh deploy instead of trying to git-pull.
    let dirExists = false;
    try {
      await fs.access(path.join(project.deploy_path, '.git'));
      dirExists = true;
    } catch {
      dirExists = false;
    }

    if (!dirExists) {
      await addLog(project.id, 'deploy', 'Deploy directory missing — running fresh deploy...');
      const dbRows = await query('SELECT * FROM project_databases WHERE project_id = ?', [project.id]);
      const dbCredentials = dbRows[0] || null;
      const envVarRows = await query('SELECT key_name, value FROM project_env_vars WHERE project_id = ?', [project.id]);
      const customEnvVars = {};
      for (const row of envVarRows) customEnvVars[row.key_name] = row.value || '';
      return await deployProject(project, accessToken, dbCredentials, customEnvVars);
    }

    const git = simpleGit(project.deploy_path);

    if (accessToken) {
      const parsed = parseRepoUrl(project.repo_url);
      if (parsed) {
        const cloneUrl = buildAuthCloneUrl(parsed, accessToken);
        await git.remote(['set-url', 'origin', cloneUrl]);
      }
    }

    await addLog(project.id, 'deploy', `Fetching latest from branch ${project.branch}...`);
    await git.fetch(['--depth', '50', 'origin', project.branch]);
    await git.reset(['--hard', `origin/${project.branch}`]);
    await addLog(project.id, 'deploy', 'Fetch and reset complete.');

    // Fetch DB credentials and env vars from DB
    const dbRows = await query('SELECT * FROM project_databases WHERE project_id = ?', [project.id]);
    const dbCredentials = dbRows[0] || null;

    const envVarRows = await query('SELECT key_name, value FROM project_env_vars WHERE project_id = ?', [project.id]);
    const customEnvVars = {};
    for (const row of envVarRows) {
      customEnvVars[row.key_name] = row.value || '';
    }

    // Re-write .env (in case vars changed)
    await generateEnvFile(project, dbCredentials, customEnvVars);

    // npm install
    await runInstallAndBuild(project);

    // PM2 restart
    await addLog(project.id, 'deploy', 'Restarting PM2 process...');
    await pm2Connect();
    try {
      const projectEnvR = await readProjectEnv(project);
      await pm2Restart(project.name).catch(async () => {
        // If not running, start it
        await pm2Delete(project.name).catch(() => {});
        await pm2Start({
          name: project.name,
          script: project.start_command && project.start_command !== 'npm start'
            ? project.start_command
            : 'npm',
          args: project.start_command && project.start_command !== 'npm start'
            ? undefined
            : ['start'],
          cwd: project.deploy_path,
          env: { NODE_ENV: 'production', PORT: String(project.port), ...projectEnvR },
          watch: false,
          autorestart: true,
          log_date_format: 'YYYY-MM-DD HH:mm:ss'
        });
      });
    } finally {
      await pm2Disconnect();
    }

    await query(
      `UPDATE projects SET status = 'active', last_deployed = CURRENT_TIMESTAMP WHERE id = ?`,
      [project.id]
    );
    await addLog(project.id, 'deploy', 'Redeploy complete!');
  } catch (err) {
    await query(`UPDATE projects SET status = 'error' WHERE id = ?`, [project.id]);
    await addLog(project.id, 'error', `Redeploy failed: ${err.message}`);
    throw err;
  }
}

// -------------------------------------------------------------------------
// stopProject
// -------------------------------------------------------------------------
async function stopProject(projectId, project) {
  await addLog(projectId, 'info', 'Stopping project...');
  await pm2Connect();
  try {
    await pm2Stop(project.name).catch(() => {});
  } finally {
    await pm2Disconnect();
  }
  await query(`UPDATE projects SET status = 'stopped' WHERE id = ?`, [projectId]);
  await addLog(projectId, 'info', 'Project stopped.');
}

// -------------------------------------------------------------------------
// startProject
// -------------------------------------------------------------------------
async function startProject(project) {
  await addLog(project.id, 'info', 'Starting project...');
  await pm2Connect();
  try {
    // Try restart first, then start
    const projectEnvS = await readProjectEnv(project);
    await pm2Restart(project.name).catch(async () => {
      await pm2Start({
        name: project.name,
        script: project.start_command && project.start_command !== 'npm start'
          ? project.start_command
          : 'npm',
        args: project.start_command && project.start_command !== 'npm start'
          ? undefined
          : ['start'],
        cwd: project.deploy_path,
        env: { NODE_ENV: 'production', PORT: String(project.port), ...projectEnvS },
        watch: false,
        autorestart: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss'
      });
    });
  } finally {
    await pm2Disconnect();
  }
  await query(`UPDATE projects SET status = 'active' WHERE id = ?`, [project.id]);
  await addLog(project.id, 'info', 'Project started.');
}

// -------------------------------------------------------------------------
// restartProject
// -------------------------------------------------------------------------
async function restartProject(project) {
  await addLog(project.id, 'info', 'Restarting project...');
  const projectEnv = await readProjectEnv(project);
  await pm2Connect();
  try {
    // Delete and recreate so PM2 config (log_date_format, env vars) are always applied
    await pm2Delete(project.name).catch(() => {});
    await pm2Start({
      name: project.name,
      script: project.start_command && project.start_command !== 'npm start'
        ? project.start_command : 'npm',
      args: project.start_command && project.start_command !== 'npm start'
        ? undefined : ['start'],
      cwd: project.deploy_path,
      env: { NODE_ENV: 'production', PORT: String(project.port), ...projectEnv },
      watch: false,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    });
  } finally {
    await pm2Disconnect();
  }
  await addLog(project.id, 'info', 'Project restarted.');
}

// -------------------------------------------------------------------------
// deleteProject
// -------------------------------------------------------------------------
async function deleteProject(projectId, deleteFiles, project) {
  await addLog(projectId, 'info', `Deleting project "${project.name}"...`);

  // Stop and remove from PM2
  await pm2Connect();
  try {
    await pm2Delete(project.name).catch(() => {});
  } finally {
    await pm2Disconnect();
  }

  // Optionally remove files
  if (deleteFiles && project.deploy_path) {
    try {
      await fs.rm(project.deploy_path, { recursive: true, force: true });
      await addLog(projectId, 'info', `Deleted deploy directory: ${project.deploy_path}`);
    } catch (err) {
      await addLog(projectId, 'error', `Failed to delete directory: ${err.message}`);
    }
  }

  // Delete from DB (cascade deletes env vars, db info, logs referencing this project)
  await query('DELETE FROM projects WHERE id = ?', [projectId]);

  // Regenerate nginx config to remove this project's location block
  await generateNginxConfig();
}

module.exports = {
  parseRepoUrl,
  getNextPort,
  generateEnvFile,
  setupGithubWebhook,
  deployProject,
  pullAndRedeploy,
  stopProject,
  startProject,
  restartProject,
  deleteProject
};
