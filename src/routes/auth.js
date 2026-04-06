'use strict';

const express = require('express');
const passport = require('passport');
const router = express.Router();

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
router.get('/github', passport.authenticate('github'));

// GET /auth/github/callback — OAuth callback
router.get(
  '/github/callback',
  passport.authenticate('github', {
    failureRedirect: '/auth/login',
    failureFlash: true
  }),
  (req, res) => {
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
