/* ============================================================================
 * ui.js — shared chrome: navigation, theme, toasts, auth guard, formatting.
 *
 * Accessibility decisions worth knowing about:
 *  - The nav is a real <nav> with aria-current on the active link.
 *  - The mobile toggle carries aria-expanded and moves focus into the menu.
 *  - Toasts live in a polite aria-live region, so announcements are read out
 *    without stealing focus from what the user is doing.
 *  - Theme choice is stored, and the toggle reports the state it is in, not
 *    the state it will move to.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var THEME_KEY = 'sonubrace.theme';

  /* ------------------------------------------------------------- theme --- */

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) || ''; } catch (e) { return ''; }
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    try { theme ? localStorage.setItem(THEME_KEY, theme) : localStorage.removeItem(THEME_KEY); }
    catch (e) { /* private mode — the theme just will not persist */ }
    updateThemeButton();
  }

  function currentTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr;
    return global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function updateThemeButton() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var dark = currentTheme() === 'dark';
    btn.textContent = dark ? '☀' : '☾';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('title', btn.getAttribute('aria-label'));
  }

  /* Applied before paint by an inline snippet in each page's head, so the
     theme never flashes. This is the runtime half. */
  function initTheme() {
    var t = storedTheme();
    if (t) document.documentElement.setAttribute('data-theme', t);
    updateThemeButton();
  }

  /* --------------------------------------------------------------- nav --- */

  var NAV = [
    { href: 'index.html',       label: 'Home',        always: true },
    { href: 'app.html',         label: 'Monitor',     auth: true },
    { href: 'calibration.html', label: 'Recordings',  auth: true },
    { href: 'analysis.html',    label: 'Analysis',    auth: true },
    { href: 'profile.html',     label: 'Health profile', auth: true },
    { href: 'methods.html',     label: 'Methods',     always: true }
  ];

  function renderHeader(signedIn) {
    var host = document.querySelector('[data-sonubrace-header]');
    if (!host) return;

    var here = location.pathname.split('/').pop() || 'index.html';
    var links = NAV.filter(function (n) { return n.always || (n.auth && signedIn); })
      .map(function (n) {
        var cur = n.href === here ? ' aria-current="page"' : '';
        return '<a href="' + n.href + '"' + cur + '>' + n.label + '</a>';
      }).join('');

    var account = signedIn
      ? '<button type="button" class="btn btn-secondary btn-sm" id="sign-out">Sign out</button>'
      : '<a class="btn btn-secondary btn-sm" href="login.html">Sign in</a>' +
        '<a class="btn btn-sm" href="register.html">Create account</a>';

    host.innerHTML =
      '<div class="wrap bar">' +
        '<a class="brand" href="index.html">' +
          '<span class="brand-mark" aria-hidden="true">◟</span>' +
          '<span>Sonubrace</span>' +
        '</a>' +
        '<button type="button" class="icon-btn nav-toggle" id="nav-toggle" ' +
          'aria-expanded="false" aria-controls="primary-nav" aria-label="Open menu">☰</button>' +
        '<nav id="primary-nav" class="nav" aria-label="Primary">' + links + '</nav>' +
        '<div class="row push" style="gap:.4rem">' +
          '<button type="button" class="icon-btn" id="theme-toggle"></button>' +
          account +
        '</div>' +
      '</div>';

    var toggle = document.getElementById('nav-toggle');
    var nav = document.getElementById('primary-nav');
    if (toggle && nav) {
      toggle.addEventListener('click', function () {
        var open = nav.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        if (open) { var first = nav.querySelector('a'); if (first) first.focus(); }
      });
      /* Escape closes the menu and returns focus to the control that opened it. */
      nav.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          nav.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        }
      });
    }

    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
    }

    var signOut = document.getElementById('sign-out');
    if (signOut) {
      signOut.addEventListener('click', function () {
        global.SonubraceDB.signOut().then(function () { location.href = 'index.html'; });
      });
    }

    updateThemeButton();
  }

  function renderFooter() {
    var host = document.querySelector('[data-sonubrace-footer]');
    if (!host) return;
    var year = new Date().getFullYear();
    host.innerHTML =
      '<div class="wrap grid grid-3">' +
        '<div>' +
          '<h2>Sonubrace</h2>' +
          '<p class="small">Continuous haemodynamic monitoring and early screening for ' +
          'non-communicable diseases, using Doppler ultrasound with truncated long code.</p>' +
        '</div>' +
        '<div>' +
          '<h2>Platform</h2>' +
          '<ul class="small">' +
            '<li><a href="app.html">Monitor</a></li>' +
            '<li><a href="calibration.html">Recordings</a></li>' +
            '<li><a href="analysis.html">Analysis</a></li>' +
            '<li><a href="methods.html">Methods and equations</a></li>' +
          '</ul>' +
        '</div>' +
        '<div>' +
          '<h2>Important</h2>' +
          '<p class="small">Sonubrace is a research and screening aid. It does not diagnose any ' +
          'condition and does not replace clinical assessment. If you have symptoms, contact a ' +
          'clinician; in an emergency, call your local emergency number.</p>' +
          '<p class="small muted">© ' + year + ' Sonubrace research project.</p>' +
        '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------ toasts --- */

  function toastRegion() {
    var r = document.getElementById('toast-region');
    if (!r) {
      r = document.createElement('div');
      r.id = 'toast-region';
      r.className = 'toast-region';
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      document.body.appendChild(r);
    }
    return r;
  }

  function toast(message, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'ok');
    el.textContent = message;
    toastRegion().appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 5000);
  }

  /* ------------------------------------------------------- auth guard --- */
  /*
   * Every signed-in page calls this first. It resolves with the user, or
   * redirects to the sign-in page carrying a `next` parameter so the user
   * lands back where they were trying to go.
   */
  function requireAuth() {
    return global.SonubraceDB.getUser().then(function (user) {
      if (!user) {
        var here = location.pathname.split('/').pop() || 'app.html';
        location.replace('login.html?next=' + encodeURIComponent(here));
        return null;
      }
      return user;
    });
  }

  /* Boots the shared chrome on every page. */
  function boot(opts) {
    opts = opts || {};
    initTheme();
    return global.SonubraceDB.getUser().then(function (user) {
      renderHeader(!!user);
      renderFooter();
      if (opts.requireAuth && !user) {
        var here = location.pathname.split('/').pop() || 'app.html';
        location.replace('login.html?next=' + encodeURIComponent(here));
        return null;
      }
      return user;
    }).catch(function (err) {
      renderHeader(false);
      renderFooter();
      console.error('[ui] boot failed', err);
      return null;
    });
  }

  /* -------------------------------------------------------- formatting --- */

  function fmt(value, digits, unit) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    var s = Number(value).toFixed(digits === undefined ? 2 : digits);
    return unit ? s + ' ' + unit : s;
  }

  function relativeTime(iso) {
    var then = new Date(iso).getTime();
    if (!then) return '';
    var diff = Math.round((Date.now() - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }

  /* Escape anything that came from a user before it reaches innerHTML.
     Recording names are user-supplied and are rendered in several places. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Field-level error reporting that satisfies WCAG 3.3.1/3.3.3: the message
     is tied to the input by aria-describedby and the input is marked invalid. */
  function setFieldError(input, message) {
    if (!input) return;
    var errId = input.id + '-error';
    var err = document.getElementById(errId);
    if (!err) {
      err = document.createElement('span');
      err.id = errId;
      err.className = 'error';
      input.insertAdjacentElement('afterend', err);
    }
    err.textContent = message || '';
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby',
        (input.getAttribute('aria-describedby') || '').replace(errId, '').trim() + ' ' + errId);
    } else {
      input.removeAttribute('aria-invalid');
    }
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('[aria-invalid="true"]').forEach(function (el) { setFieldError(el, ''); });
    var summary = form.querySelector('[data-error-summary]');
    if (summary) { summary.hidden = true; summary.innerHTML = ''; }
  }

  /* An error summary at the top of the form, focused on submit — the pattern
     screen-reader users expect when a submission fails validation. */
  function showFormErrors(form, errors) {
    var summary = form.querySelector('[data-error-summary]');
    if (!summary || !errors.length) return;
    summary.hidden = false;
    summary.className = 'alert alert-risk';
    summary.innerHTML =
      '<div><h3>There ' + (errors.length === 1 ? 'is 1 problem' : 'are ' + errors.length + ' problems') +
      ' with this form</h3><ul>' +
      errors.map(function (e) {
        return '<li><a href="#' + e.id + '">' + esc(e.message) + '</a></li>';
      }).join('') + '</ul></div>';
    summary.setAttribute('tabindex', '-1');
    summary.focus();
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name) || '';
  }

  global.SonubraceUI = {
    boot: boot,
    initTheme: initTheme,
    applyTheme: applyTheme,
    currentTheme: currentTheme,
    renderHeader: renderHeader,
    renderFooter: renderFooter,
    requireAuth: requireAuth,
    toast: toast,
    fmt: fmt,
    esc: esc,
    relativeTime: relativeTime,
    setFieldError: setFieldError,
    clearFieldErrors: clearFieldErrors,
    showFormErrors: showFormErrors,
    download: download,
    qs: qs
  };
})(window);
