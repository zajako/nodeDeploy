'use strict';

const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const { query } = require('../config/database');
const deployService = require('../services/deployService');

// Apply isAdmin to all admin routes
router.use(isAdmin);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
function renderLocals(req, extra = {}) {
  return Object.assign(
    {
      user: req.user,
      messages: {
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info')
      }
    },
    extra
  );
}

function validateProjectName(name) {
  return /^[a-zA-Z0-9_-]{2,50}$/.test(name);
}

// -----------------------------------------------------------------------
// GET /admin — dashboard
// -----------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects ORDER BY created_at DESC');

    const stats = {
      total: projects.length,
      active: projects.filter((p) => p.status === 'active').length,
      stopped: projects.filter((p) => p.status === 'stopped').length,
      error: projects.filter((p) => p.status === 'error').length,
      deploying: projects.filter((p) => p.status === 'deploying').length
    };

    const recentLogs = await query(
      `SELECT dl.*, p.name as project_name
       FROM deploy_logs dl
       LEFT JOIN projects p ON dl.project_id = p.id
       ORDER BY dl.created_at DESC
       LIMIT 20`
    );

    res.render('dashboard', renderLocals(req, { title: 'Dashboard - NodeDeploy', stats, recentLogs, projects }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /admin/projects — project list
// -----------------------------------------------------------------------
router.get('/projects', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects ORDER BY created_at DESC');
    res.render('projects/index', renderLocals(req, { title: 'Projects - NodeDeploy', projects }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /admin/projects/new — new project form
// -----------------------------------------------------------------------
router.get('/projects/new', (req, res) => {
  res.render('projects/new', renderLocals(req, { title: 'New Project - NodeDeploy' }));
});

// -----------------------------------------------------------------------
// POST /admin/projects — create project
// -----------------------------------------------------------------------
router.post('/projects', async (req, res, next) => {
  try {
    const {
      name,
      repo_url,
      branch = 'main',
      start_command = 'npm start',
      build_command,
      link_db,
      db_name,
      db_user,
      db_password,
      env_keys = [],
      env_values = []
    } = req.body;

    // Validation
    if (!name || !validateProjectName(name)) {
      req.flash('error', 'Invalid project name. Use 2-50 alphanumeric characters, hyphens, or underscores.');
      return res.redirect('/admin/projects/new');
    }
    if (!repo_url) {
      req.flash('error', 'Repository URL is required.');
      return res.redirect('/admin/projects/new');
    }

    // Check uniqueness
    const existing = await query('SELECT id FROM projects WHERE name = ?', [name]);
    if (existing.length > 0) {
      req.flash('error', `A project named "${name}" already exists.`);
      return res.redirect('/admin/projects/new');
    }

    // Parse repo owner/name
    const parsed = deployService.parseRepoUrl(repo_url);
    if (!parsed) {
      req.flash('error', 'Could not parse GitHub repository URL.');
      return res.redirect('/admin/projects/new');
    }

    const port = await deployService.getNextPort();
    const deployPath = `${process.env.DEPLOY_BASE_PATH || '/var/www/nodeapps'}/${name}`;

    // Insert project record
    const result = await query(
      `INSERT INTO projects
         (name, repo_url, repo_owner, repo_name, branch, port, status, deploy_path, start_command, build_command, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'deploying', ?, ?, ?, ?)`,
      [name, repo_url, parsed.owner, parsed.repo, branch, port, deployPath, start_command, build_command || null, req.user.id]
    );
    const projectId = result.insertId;

    // Linked DB credentials
    let dbCredentials = null;
    if (link_db === 'on' || link_db === '1' || link_db === true) {
      if (db_name && db_user && db_password) {
        await query(
          `INSERT INTO project_databases (project_id, db_name, db_user, db_password) VALUES (?, ?, ?, ?)`,
          [projectId, db_name, db_user, db_password]
        );
        dbCredentials = { db_name, db_user, db_password, db_host: 'localhost', db_port: 3306 };
      }
    }

    // Custom env vars
    const keysArr = Array.isArray(env_keys) ? env_keys : [env_keys];
    const valsArr = Array.isArray(env_values) ? env_values : [env_values];
    const customEnvVars = {};
    for (let i = 0; i < keysArr.length; i++) {
      const k = (keysArr[i] || '').trim();
      if (k) {
        customEnvVars[k] = valsArr[i] || '';
        await query(
          `INSERT INTO project_env_vars (project_id, key_name, value) VALUES (?, ?, ?)`,
          [projectId, k, valsArr[i] || '']
        );
      }
    }

    // Fetch full project
    const projects = await query('SELECT * FROM projects WHERE id = ?', [projectId]);
    const project = projects[0];

    // Deploy asynchronously so we can redirect immediately
    deployService.deployProject(project, req.user.access_token, dbCredentials, customEnvVars).catch((err) => {
      console.error('Deploy error:', err);
    });

    req.flash('success', `Project "${name}" is being deployed. Check the project page for status.`);
    res.redirect(`/admin/projects/${projectId}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /admin/projects/:id — show project
// -----------------------------------------------------------------------
router.get('/projects/:id', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    const project = projects[0];

    const dbRows = await query('SELECT * FROM project_databases WHERE project_id = ?', [project.id]);
    const dbInfo = dbRows[0] || null;

    const envVars = await query('SELECT * FROM project_env_vars WHERE project_id = ? ORDER BY key_name', [project.id]);

    const logs = await query(
      `SELECT * FROM deploy_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`,
      [project.id]
    );

    res.render('projects/show', renderLocals(req, {
      title: `${project.name} - NodeDeploy`,
      project,
      dbInfo,
      envVars,
      logs
    }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /admin/projects/:id/edit — edit form
// -----------------------------------------------------------------------
router.get('/projects/:id/edit', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    const project = projects[0];
    res.render('projects/edit', renderLocals(req, { title: `Edit ${project.name} - NodeDeploy`, project }));
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /admin/projects/:id — update project
// -----------------------------------------------------------------------
router.post('/projects/:id', async (req, res, next) => {
  try {
    const { branch, start_command, build_command } = req.body;
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    await query(
      `UPDATE projects SET branch = ?, start_command = ?, build_command = ? WHERE id = ?`,
      [branch || 'main', start_command || 'npm start', build_command || null, req.params.id]
    );
    req.flash('success', 'Project updated successfully.');
    res.redirect(`/admin/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// DELETE /admin/projects/:id — delete project
// -----------------------------------------------------------------------
router.delete('/projects/:id', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    const project = projects[0];
    const deleteFiles = req.body.delete_files === 'on' || req.body.delete_files === '1';

    await deployService.deleteProject(project.id, deleteFiles, project);
    req.flash('success', `Project "${project.name}" has been deleted.`);
    res.redirect('/admin/projects');
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /admin/projects/:id/deploy — manual redeploy
// -----------------------------------------------------------------------
router.post('/projects/:id/deploy', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    const project = projects[0];

    deployService.pullAndRedeploy(project).catch((err) => {
      console.error('Redeploy error:', err);
    });

    req.flash('success', 'Redeployment triggered.');
    res.redirect(`/admin/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /admin/projects/:id/restart
// -----------------------------------------------------------------------
router.post('/projects/:id/restart', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    await deployService.restartProject(projects[0]);
    req.flash('success', 'Project restarted.');
    res.redirect(`/admin/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /admin/projects/:id/stop
// -----------------------------------------------------------------------
router.post('/projects/:id/stop', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    await deployService.stopProject(projects[0].id, projects[0]);
    req.flash('success', 'Project stopped.');
    res.redirect(`/admin/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// POST /admin/projects/:id/start
// -----------------------------------------------------------------------
router.post('/projects/:id/start', async (req, res, next) => {
  try {
    const projects = await query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!projects.length) {
      req.flash('error', 'Project not found.');
      return res.redirect('/admin/projects');
    }
    await deployService.startProject(projects[0]);
    req.flash('success', 'Project started.');
    res.redirect(`/admin/projects/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// -----------------------------------------------------------------------
// GET /admin/projects/:id/logs — JSON endpoint for log polling
// -----------------------------------------------------------------------
router.get('/projects/:id/logs', async (req, res, next) => {
  try {
    const logs = await query(
      `SELECT * FROM deploy_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
