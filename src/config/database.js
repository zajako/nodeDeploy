'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'nodedeploy',
  user: process.env.DB_USER || 'nodedeploy_user',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
  charset: 'utf8mb4'
});

/**
 * Helper to run a query against the pool.
 * @param {string} sql
 * @param {Array} [params]
 * @returns {Promise<Array>} rows
 */
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = { pool, query };
