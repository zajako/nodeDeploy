'use strict';

/**
 * Ensure the request is authenticated.
 * Redirects to /auth/login if not.
 */
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  req.flash('error', 'You must be logged in to access that page.');
  res.redirect('/auth/login');
}

/**
 * Ensure the request is authenticated AND the user is an admin.
 * Redirects to / with an error flash if not.
 */
function isAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user && req.user.is_admin) {
    return next();
  }
  if (!req.isAuthenticated()) {
    req.flash('error', 'You must be logged in to access that page.');
    return res.redirect('/auth/login');
  }
  req.flash('error', 'You do not have permission to access that page.');
  res.redirect('/');
}

module.exports = { isAuthenticated, isAdmin };
