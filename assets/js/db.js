/* ============================================================================
 * db.js — accounts, health profile and recordings.
 *
 * One API, two backends:
 *
 *   REMOTE  When config.js carries a Supabase URL and anon key, every call
 *           goes to hosted Postgres with row-level security (sql/schema.sql).
 *           Real server accounts, real database, reachable from any device.
 *
 *   LOCAL   Otherwise everything is kept in this browser. Passwords are
 *           PBKDF2-SHA256 hashed with a per-user salt (600k iterations) and
 *           never stored in the clear. This exists so the platform is usable
 *           the moment you open it, and so a demo never ships health data off
 *           the device — but it is per-browser, so it is not a substitute for
 *           the remote backend in production.
 *
 * Every method returns a Promise, whichever backend is active.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var LS_USERS   = 'sonubrace.users';
  var LS_SESSION = 'sonubrace.session';
  var LS_PROFILE = 'sonubrace.profile.';
  var LS_RECS    = 'sonubrace.recordings.';

  function conf() {
    return (global.SONUBRACE_CONFIG && global.SONUBRACE_CONFIG.supabase) || {};
  }
  function remoteConfigured() {
    var c = conf();
    return !!(c.url && c.anonKey);
  }

  /* --------------------------------------------------------- utilities --- */

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      console.error('[db] local storage write failed', e);
      return false;
    }
  }

  function bufToHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf),
      function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* PBKDF2-SHA256. Deliberately slow: it is the only thing standing between a
     stolen localStorage dump and the user's password.                       */
  function hashPassword(password, saltHex) {
    if (!(global.crypto && crypto.subtle)) {
      return Promise.reject(new Error(
        'This browser cannot hash passwords securely (Web Crypto unavailable). ' +
        'Open the site over https.'));
    }
    var enc = new TextEncoder();
    var salt = new Uint8Array(saltHex.match(/.{2}/g).map(function (h) { return parseInt(h, 16); }));
    return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: salt, iterations: 600000, hash: 'SHA-256' }, key, 256);
      })
      .then(bufToHex);
  }

  function randomSaltHex() {
    var a = new Uint8Array(16);
    (global.crypto || {}).getRandomValues
      ? crypto.getRandomValues(a)
      : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    return bufToHex(a.buffer);
  }

  /* Constant-time-ish comparison, so a timing side channel cannot leak the
     hash one byte at a time. */
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
  }

  /* Password policy, stated to the user up front rather than enforced by
     surprise at submit time. */
  function passwordProblem(pw) {
    pw = String(pw || '');
    if (pw.length < 10) return 'Use at least 10 characters.';
    if (!/[a-z]/.test(pw)) return 'Include at least one lowercase letter.';
    if (!/[A-Z]/.test(pw)) return 'Include at least one uppercase letter.';
    if (!/[0-9]/.test(pw)) return 'Include at least one number.';
    return '';
  }

  /* ------------------------------------------------------ remote client --- */

  var supabasePromise = null;
  function getSupabase() {
    if (!remoteConfigured()) return Promise.resolve(null);
    if (supabasePromise) return supabasePromise;

    supabasePromise = new Promise(function (resolve, reject) {
      if (global.supabase && global.supabase.createClient) return resolve(global.supabase);
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.async = true;
      s.onload = function () { resolve(global.supabase); };
      s.onerror = function () { reject(new Error('Could not load the Supabase client.')); };
      document.head.appendChild(s);
    }).then(function (lib) {
      var c = conf();
      return lib.createClient(c.url, c.anonKey);
    });

    return supabasePromise;
  }

  /* ============================== the API ================================= */

  var DB = {

    mode: function () { return remoteConfigured() ? 'remote' : 'local'; },
    isRemote: remoteConfigured,
    passwordProblem: passwordProblem,
    validEmail: validEmail,

    /* ------------------------------------------------------------ auth --- */

    signUp: function (email, password, fullName) {
      email = String(email || '').trim().toLowerCase();
      if (!validEmail(email)) return Promise.reject(new Error('Enter a valid email address.'));
      var problem = passwordProblem(password);
      if (problem) return Promise.reject(new Error(problem));

      if (remoteConfigured()) {
        return getSupabase().then(function (sb) {
          return sb.auth.signUp({
            email: email, password: password,
            options: { data: { full_name: fullName || '' } }
          });
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          /* With email confirmation on, session is null until the user clicks
             the link — say so rather than pretending they are signed in. */
          return {
            user: res.data.user,
            needsConfirmation: !res.data.session,
            mode: 'remote'
          };
        });
      }

      var users = readJSON(LS_USERS, {});
      if (users[email]) return Promise.reject(new Error('An account with that email already exists on this device.'));

      var salt = randomSaltHex();
      return hashPassword(password, salt).then(function (hash) {
        users[email] = {
          id: uid(), email: email, fullName: fullName || '',
          salt: salt, hash: hash, createdAt: new Date().toISOString()
        };
        writeJSON(LS_USERS, users);
        writeJSON(LS_SESSION, { email: email, at: Date.now() });
        return { user: { id: users[email].id, email: email }, needsConfirmation: false, mode: 'local' };
      });
    },

    signIn: function (email, password) {
      email = String(email || '').trim().toLowerCase();

      if (remoteConfigured()) {
        return getSupabase().then(function (sb) {
          return sb.auth.signInWithPassword({ email: email, password: password });
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return { user: res.data.user, mode: 'remote' };
        });
      }

      var users = readJSON(LS_USERS, {});
      var rec = users[email];
      /* Same message whether the email is unknown or the password is wrong —
         otherwise the form becomes an account-enumeration oracle. */
      var generic = 'Email or password is incorrect.';
      if (!rec) return Promise.reject(new Error(generic));

      return hashPassword(password, rec.salt).then(function (hash) {
        if (!safeEqual(hash, rec.hash)) throw new Error(generic);
        writeJSON(LS_SESSION, { email: email, at: Date.now() });
        return { user: { id: rec.id, email: email, fullName: rec.fullName }, mode: 'local' };
      });
    },

    signOut: function () {
      if (remoteConfigured()) {
        return getSupabase().then(function (sb) { return sb.auth.signOut(); })
          .then(function () { return true; });
      }
      localStorage.removeItem(LS_SESSION);
      return Promise.resolve(true);
    },

    /* Resolves to the signed-in user or null. Every protected page calls this
       first. */
    getUser: function () {
      if (remoteConfigured()) {
        return getSupabase().then(function (sb) { return sb.auth.getUser(); })
          .then(function (res) {
            if (res.error || !res.data.user) return null;
            var u = res.data.user;
            return {
              id: u.id, email: u.email,
              fullName: (u.user_metadata && u.user_metadata.full_name) || ''
            };
          })
          .catch(function () { return null; });
      }
      var sess = readJSON(LS_SESSION, null);
      if (!sess) return Promise.resolve(null);
      var rec = readJSON(LS_USERS, {})[sess.email];
      if (!rec) return Promise.resolve(null);
      return Promise.resolve({ id: rec.id, email: rec.email, fullName: rec.fullName });
    },

    requestPasswordReset: function (email) {
      if (remoteConfigured()) {
        return getSupabase().then(function (sb) {
          return sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), {
            redirectTo: location.origin + location.pathname.replace(/[^/]*$/, '') + 'login.html'
          });
        }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return true;
        });
      }
      return Promise.reject(new Error(
        'Password reset needs the hosted backend. In local mode there is no email service, ' +
        'so a forgotten password cannot be recovered.'));
    },

    /* -------------------------------------------------- health profile --- */
    /*
     * The intake questionnaire. These fields are the non-signal inputs the
     * machine-learning layer combines with the Doppler parameters, exactly as
     * the methods document describes ("user profile" among the ML inputs).
     */
    saveProfile: function (profile) {
      var self = this;
      return this.getUser().then(function (user) {
        if (!user) throw new Error('Sign in first.');
        var row = Object.assign({}, profile, {
          user_id: user.id,
          updated_at: new Date().toISOString()
        });
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('health_profiles').upsert(row, { onConflict: 'user_id' });
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return row;
          });
        }
        writeJSON(LS_PROFILE + user.id, row);
        return row;
      });
    },

    getProfile: function () {
      return this.getUser().then(function (user) {
        if (!user) return null;
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('health_profiles').select('*').eq('user_id', user.id).maybeSingle();
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data || null;
          });
        }
        return readJSON(LS_PROFILE + user.id, null);
      });
    },

    /* ----------------------------------------------------- recordings ---- */
    /*
     * A recording stores the computed parameters and a compact copy of the
     * envelope, not the raw spectrogram — a full P(f,t) matrix is megabytes,
     * and everything the analysis and the AI need is derivable from the
     * envelope plus the parameters.
     */
    saveRecording: function (rec) {
      return this.getUser().then(function (user) {
        if (!user) throw new Error('Sign in first.');
        var row = {
          id: rec.id || uid(),
          user_id: user.id,
          name: rec.name || defaultRecordingName(),
          created_at: rec.created_at || new Date().toISOString(),
          source: rec.source || 'simulation',
          scenario: rec.scenario || null,
          duration_s: rec.duration_s || 0,
          site: rec.site || 'radial',
          angle_deg: rec.angle_deg || null,
          signal_quality: rec.signal_quality || 0,
          params: rec.params || {},
          envelope: rec.envelope || null,
          notes: rec.notes || ''
        };
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('recordings').upsert(row);
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return row;
          });
        }
        var list = readJSON(LS_RECS + user.id, []);
        var i = list.findIndex(function (r) { return r.id === row.id; });
        if (i >= 0) list[i] = row; else list.unshift(row);
        if (!writeJSON(LS_RECS + user.id, list)) {
          throw new Error('This browser is out of storage. Delete an old recording and try again.');
        }
        return row;
      });
    },

    listRecordings: function () {
      return this.getUser().then(function (user) {
        if (!user) return [];
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('recordings').select('*')
              .eq('user_id', user.id).order('created_at', { ascending: false });
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data || [];
          });
        }
        return readJSON(LS_RECS + user.id, []);
      });
    },

    getRecording: function (id) {
      return this.listRecordings().then(function (list) {
        return list.find(function (r) { return r.id === id; }) || null;
      });
    },

    /* The user names their own recordings — required by the brief, and the
       reason the name is a first-class column rather than a derived label. */
    renameRecording: function (id, name) {
      name = String(name || '').trim();
      if (!name) return Promise.reject(new Error('Give the recording a name.'));
      if (name.length > 80) return Promise.reject(new Error('Keep the name under 80 characters.'));

      return this.getUser().then(function (user) {
        if (!user) throw new Error('Sign in first.');
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('recordings').update({ name: name }).eq('id', id).eq('user_id', user.id);
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return name;
          });
        }
        var list = readJSON(LS_RECS + user.id, []);
        var r = list.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Recording not found.');
        r.name = name;
        writeJSON(LS_RECS + user.id, list);
        return name;
      });
    },

    updateRecording: function (id, patch) {
      return this.getUser().then(function (user) {
        if (!user) throw new Error('Sign in first.');
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('recordings').update(patch).eq('id', id).eq('user_id', user.id);
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return true;
          });
        }
        var list = readJSON(LS_RECS + user.id, []);
        var r = list.find(function (x) { return x.id === id; });
        if (!r) throw new Error('Recording not found.');
        Object.assign(r, patch);
        writeJSON(LS_RECS + user.id, list);
        return true;
      });
    },

    deleteRecording: function (id) {
      return this.getUser().then(function (user) {
        if (!user) throw new Error('Sign in first.');
        if (remoteConfigured()) {
          return getSupabase().then(function (sb) {
            return sb.from('recordings').delete().eq('id', id).eq('user_id', user.id);
          }).then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return true;
          });
        }
        var list = readJSON(LS_RECS + user.id, []).filter(function (r) { return r.id !== id; });
        writeJSON(LS_RECS + user.id, list);
        return true;
      });
    },

    /* Export everything this user owns, as a JSON file they can keep or hand
       to a clinician. Data portability, and a safety net in local mode. */
    exportAll: function () {
      var self = this;
      return Promise.all([this.getUser(), this.getProfile(), this.listRecordings()])
        .then(function (r) {
          return {
            exportedAt: new Date().toISOString(),
            platform: 'Sonubrace ' + ((global.SONUBRACE_CONFIG || {}).version || ''),
            mode: self.mode(),
            user: r[0] ? { id: r[0].id, email: r[0].email, fullName: r[0].fullName } : null,
            healthProfile: r[1],
            recordings: r[2]
          };
        });
    }
  };

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* Default name a user can immediately edit — date first so recordings sort
     sensibly by name as well as by time. */
  function defaultRecordingName() {
    var d = new Date();
    return 'Session ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  DB.defaultRecordingName = defaultRecordingName;
  DB.uid = uid;

  global.SonubraceDB = DB;
})(window);
