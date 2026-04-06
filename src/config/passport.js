'use strict';

require('dotenv').config();
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const { query } = require('./database');

const ADMIN_USERNAMES = (process.env.ADMIN_GITHUB_USERNAMES || '')
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL,
      scope: ['user:email', 'repo', 'admin:repo_hook']
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const githubId = String(profile.id);
        const username = profile.username || '';
        const displayName = profile.displayName || username;
        const avatarUrl =
          (profile.photos && profile.photos[0] && profile.photos[0].value) || '';
        const isAdmin = ADMIN_USERNAMES.includes(username.toLowerCase()) ? 1 : 0;

        await query(
          `INSERT INTO users (github_id, username, display_name, avatar_url, access_token, is_admin)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             username = VALUES(username),
             display_name = VALUES(display_name),
             avatar_url = VALUES(avatar_url),
             access_token = VALUES(access_token),
             is_admin = VALUES(is_admin),
             updated_at = CURRENT_TIMESTAMP`,
          [githubId, username, displayName, avatarUrl, accessToken, isAdmin]
        );

        const rows = await query('SELECT * FROM users WHERE github_id = ?', [githubId]);
        const user = rows[0];

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const rows = await query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows || rows.length === 0) {
      return done(null, false);
    }
    done(null, rows[0]);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;
