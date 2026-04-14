-- Migration 001: Add custom_domain column to projects
-- Run with: mysql -u nodedeploy_user -p nodedeploy < sql/migrations/001_add_custom_domain.sql

ALTER TABLE projects
  ADD COLUMN custom_domain VARCHAR(255) UNIQUE DEFAULT NULL
    COMMENT 'Optional custom domain (e.g. myapp.com)'
  AFTER webhook_id;
