-- ============================================================
-- NodeDeploy — Database Setup
-- Run as MySQL root: mysql -u root -p < setup.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS nodedeploy
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE nodedeploy;

-- ---- Users ----
CREATE TABLE IF NOT EXISTS users (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  github_id    VARCHAR(255) UNIQUE NOT NULL,
  username     VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  avatar_url   TEXT,
  access_token TEXT,
  is_admin     TINYINT(1) DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Projects ----
CREATE TABLE IF NOT EXISTS projects (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) UNIQUE NOT NULL  COMMENT 'URL slug, used as PM2 process name',
  repo_url      TEXT NOT NULL,
  repo_owner    VARCHAR(255),
  repo_name     VARCHAR(255),
  branch        VARCHAR(255) DEFAULT 'main',
  port          INT UNIQUE NOT NULL            COMMENT 'Port the app listens on (4000+)',
  status        ENUM('active', 'stopped', 'error', 'deploying') DEFAULT 'deploying',
  webhook_secret VARCHAR(255)                 COMMENT 'HMAC secret shared with GitHub',
  webhook_id    VARCHAR(255)                  COMMENT 'GitHub webhook id for management',
  deploy_path   TEXT NOT NULL                 COMMENT 'Absolute path on disk',
  start_command VARCHAR(255) DEFAULT 'npm start',
  build_command VARCHAR(255),
  created_by    INT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_deployed TIMESTAMP NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Per-project MySQL credentials ----
CREATE TABLE IF NOT EXISTS project_databases (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNIQUE NOT NULL,
  db_name    VARCHAR(255) NOT NULL,
  db_user    VARCHAR(255) NOT NULL,
  db_password VARCHAR(255) NOT NULL,
  db_host    VARCHAR(255) DEFAULT 'localhost',
  db_port    INT DEFAULT 3306,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Custom environment variables ----
CREATE TABLE IF NOT EXISTS project_env_vars (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NOT NULL,
  key_name   VARCHAR(255) NOT NULL,
  value      TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Deploy logs ----
CREATE TABLE IF NOT EXISTS deploy_logs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT,
  log_type   ENUM('deploy', 'webhook', 'error', 'info') DEFAULT 'deploy',
  message    TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Indexes for common queries ----
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status);
CREATE INDEX IF NOT EXISTS idx_deploy_logs_project ON deploy_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_env_project ON project_env_vars(project_id);

-- ============================================================
-- Create application user (run as root, adjust password)
-- ============================================================
-- CREATE USER IF NOT EXISTS 'nodedeploy_user'@'localhost' IDENTIFIED BY 'secure_password_here';
-- GRANT ALL PRIVILEGES ON nodedeploy.* TO 'nodedeploy_user'@'localhost';
-- FLUSH PRIVILEGES;
