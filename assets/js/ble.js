/* ============================================================================
 * ble.js — Bluetooth Low Energy link to the Sonubrace band.
 *
 * The methods document specifies BLE as the transport that makes the
 * monitoring continuous: the microcontroller finishes Phase 1 up to the
 * decoded Doppler signal, then streams baseband I/Q plus IMU orientation to
 * the browser, which runs the STFT and the parameter maths.
 *
 * WIRE FORMAT (little-endian) — match this in your firmware:
 *
 *   byte  0      0xSB marker (0x5B)
 *   byte  1      packet type: 0x01 = IQ block, 0x02 = IMU, 0x03 = status
 *   bytes 2-3    uint16 sequence number
 *
 *   type 0x01 (IQ block), repeated to the end of the packet:
 *     int16 I, int16 Q          scaled by 1/32768
 *
 *   type 0x02 (IMU):
 *     int16 angle_centideg      insonation angle * 100
 *     int16 roll_centideg
 *     int16 gyro_centidps       gyro magnitude * 100
 *
 *   type 0x03 (status):
 *     uint8 battery_percent
 *     uint8 flags   bit0 = probe in contact, bit1 = code lock acquired
 *
 * Web Bluetooth needs HTTPS (GitHub Pages qualifies) or localhost, and only
 * works in Chrome, Edge and Opera. isSupported() lets the UI say so plainly
 * instead of failing silently.
 * ==========================================================================*/

(function (global) {
  'use strict';

  var MARKER = 0x5B;
  var TYPE_IQ = 0x01, TYPE_IMU = 0x02, TYPE_STATUS = 0x03;

  function cfg() {
    return (global.SONUBRACE_CONFIG && global.SONUBRACE_CONFIG.ble) || {};
  }

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function unsupportedReason() {
    if (typeof navigator === 'undefined') return 'No browser environment.';
    if (!navigator.bluetooth) {
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        return 'Web Bluetooth needs a secure (https) connection. Open the published site rather than a local file.';
      }
      return 'This browser does not support Web Bluetooth. Chrome, Edge or Opera on desktop or Android will work; Safari and Firefox will not.';
    }
    return '';
  }

  /* --------------------------------------------------------------- link --- */

  function BleLink() {
    this.device = null;
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.connected = false;
    this.handlers = { iq: [], imu: [], status: [], connection: [], error: [] };
    this.lastSeq = -1;
    this.droppedPackets = 0;
    this._onDisconnect = this._handleDisconnect.bind(this);
  }

  BleLink.prototype.on = function (event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  };
  BleLink.prototype._emit = function (event, payload) {
    var list = this.handlers[event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error('[ble] handler failed', e); }
    }
  };

  /* Must be called from a user gesture — the browser shows its own device
     chooser, which is the user's consent step. */
  BleLink.prototype.connect = function () {
    var self = this;
    var c = cfg();

    if (!isSupported()) {
      var reason = unsupportedReason();
      this._emit('error', reason);
      return Promise.reject(new Error(reason));
    }

    return navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: c.namePrefix || 'Sonubrace' }],
      optionalServices: [c.serviceUuid]
    })
      .then(function (device) {
        self.device = device;
        device.addEventListener('gattserverdisconnected', self._onDisconnect);
        return device.gatt.connect();
      })
      .then(function (server) {
        self.server = server;
        return server.getPrimaryService(c.serviceUuid);
      })
      .then(function (service) {
        return Promise.all([
          service.getCharacteristic(c.rxCharUuid),
          service.getCharacteristic(c.txCharUuid).catch(function () { return null; })
        ]);
      })
      .then(function (chars) {
        self.rxChar = chars[0];
        self.txChar = chars[1];
        self.rxChar.addEventListener('characteristicvaluechanged', function (e) {
          self._parse(e.target.value);
        });
        return self.rxChar.startNotifications();
      })
      .then(function () {
        self.connected = true;
        self._emit('connection', { connected: true, name: self.device.name });
        return self.device.name;
      })
      .catch(function (err) {
        /* A user closing the chooser is a normal outcome, not a fault. */
        var msg = err && err.name === 'NotFoundError'
          ? 'No Sonubrace band was selected.'
          : (err && err.message) || String(err);
        self._emit('error', msg);
        throw err;
      });
  };

  BleLink.prototype.disconnect = function () {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this._handleDisconnect();
  };

  BleLink.prototype._handleDisconnect = function () {
    this.connected = false;
    this.rxChar = null;
    this.txChar = null;
    this._emit('connection', { connected: false });
  };

  /* Send a command to the band (start, stop, set gain, ...). */
  BleLink.prototype.send = function (bytes) {
    if (!this.txChar) return Promise.reject(new Error('Not connected.'));
    return this.txChar.writeValue(new Uint8Array(bytes));
  };
  BleLink.prototype.startStream = function () { return this.send([MARKER, 0x10, 0x01]); };
  BleLink.prototype.stopStream  = function () { return this.send([MARKER, 0x10, 0x00]); };

  /* ------------------------------------------------------------- parse --- */

  BleLink.prototype._parse = function (dv) {
    if (!dv || dv.byteLength < 4) return;
    if (dv.getUint8(0) !== MARKER) return;

    var type = dv.getUint8(1);
    var seq = dv.getUint16(2, true);

    /* Track dropped packets so the UI can report link quality honestly
       rather than silently interpolating over gaps. */
    if (this.lastSeq >= 0) {
      var expected = (this.lastSeq + 1) & 0xFFFF;
      if (seq !== expected) {
        this.droppedPackets += (seq - expected + 0x10000) & 0xFFFF;
      }
    }
    this.lastSeq = seq;

    if (type === TYPE_IQ) {
      var n = (dv.byteLength - 4) >> 2;               /* 4 bytes per I/Q pair */
      if (n <= 0) return;
      var I = new Float64Array(n), Q = new Float64Array(n);
      for (var k = 0; k < n; k++) {
        I[k] = dv.getInt16(4 + k * 4, true) / 32768;
        Q[k] = dv.getInt16(6 + k * 4, true) / 32768;
      }
      this._emit('iq', { I: I, Q: Q, seq: seq });

    } else if (type === TYPE_IMU && dv.byteLength >= 10) {
      this._emit('imu', {
        angle: dv.getInt16(4, true) / 100,
        roll:  dv.getInt16(6, true) / 100,
        gyro:  dv.getInt16(8, true) / 100,
        seq: seq
      });

    } else if (type === TYPE_STATUS && dv.byteLength >= 6) {
      var flags = dv.getUint8(5);
      this._emit('status', {
        battery: dv.getUint8(4),
        contact: !!(flags & 0x01),
        codeLock: !!(flags & 0x02),
        droppedPackets: this.droppedPackets,
        seq: seq
      });
    }
  };

  global.SonubraceBLE = {
    BleLink: BleLink,
    isSupported: isSupported,
    unsupportedReason: unsupportedReason,
    MARKER: MARKER,
    TYPE_IQ: TYPE_IQ,
    TYPE_IMU: TYPE_IMU,
    TYPE_STATUS: TYPE_STATUS
  };
})(window);
