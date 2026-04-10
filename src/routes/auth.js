'use strict';

const express = require('express');
const passport = require('passport');
const router = express.Router();

const REMEMBER_ME_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_AGE     =      24 * 60 * 60 * 1000; // 1 day

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/admin');
  }
  res.render('login', {
    title: 'Sign In - NodeDeploy',
    user: req.user || null,
    messages: {
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info')
    }
  });
});

// GET /auth/github — initiate OAuth flow
// Accept ?remember=1 from the login form and stash it in the session so the
// callback handler can extend the cookie lifetime after auth completes.
router.get('/github', (req, res, next) => {
  req.session.rememberMe = req.query.remember === '1';
  passport.authenticate('github')(req, res, next);
});

// GET /auth/github/callback — OAuth callback
router.get(
  '/github/callback',
  passport.authenticate('github', {
    failureRedirect: '/auth/login',
    failureFlash: true
  }),
  (req, res) => {
    if (req.session.rememberMe) {
      req.session.cookie.maxAge = REMEMBER_ME_AGE;
    } else {
      req.session.cookie.maxAge = DEFAULT_AGE;
    }
    req.flash('success', `Welcome back, ${req.user.username}!`);
    res.redirect('/admin');
  }
);

// POST /auth/logout
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.flash('info', 'You have been logged out.');
    res.redirect('/');
  });
});

module.exports = router;
