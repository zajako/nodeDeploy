'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../config/database');
const deployService = require('../services/deployService');

// POST /webhook/:projectName
router.post('/:projectName', async (req, res) => {
  const { projectName } = req.params;

  try {
    // Lookup project
    const projects = await query('SELECT * FROM projects WHERE name = ?', [projectName]);
    if (!projects.length) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const project = projects[0];

    // Verify GitHub signature
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    // req.body is a Buffer (raw) because of express.raw() middleware in app.js
    const rawBody = req.body;
    const expectedSig = `sha256=${crypto
      .createHmac('sha256', project.webhook_secret || '')
      .update(rawBody)
      .digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse payload
    const payload = JSON.parse(rawBody.toString('utf8'));

    // Check if push is to the watched branch
    const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
    if (pushedBranch !== project.branch) {
      return res.status(200).json({ message: `Ignoring push to branch ${pushedBranch}` });
    }

    // Log webhook receipt
    await query(
      `INSERT INTO deploy_logs (project_id, log_type, message) VALUES (?, 'webhook', ?)`,
      [project.id, `Webhook received for branch ${pushedBranch}, triggering redeploy.`]
    );

    // Trigger async redeploy
    deployService.pullAndRedeploy(project).catch((err) => {
      console.error('Webhook redeploy error:', err);
    });

    return res.status(200).json({ message: 'Deployment triggered' });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
