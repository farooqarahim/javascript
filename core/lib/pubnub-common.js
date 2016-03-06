'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

/* eslint camelcase: 0, no-use-before-define: 0, no-unused-expressions: 0  */
/* eslint eqeqeq: 0, one-var: 0 */
/* eslint no-redeclare: 0 */
/* eslint guard-for-in: 0 */
/* eslint block-scoped-var: 0 space-return-throw-case: 0, no-unused-vars: 0 */

var _uuid = require('uuid');

var _uuid2 = _interopRequireDefault(_uuid);

var _networking = require('./components/networking');

var _networking2 = _interopRequireDefault(_networking);

var _keychain = require('./components/keychain');

var _keychain2 = _interopRequireDefault(_keychain);

var _config = require('./components/config');

var _config2 = _interopRequireDefault(_config);

var _state = require('./components/state');

var _state2 = _interopRequireDefault(_state);

var _responders = require('./presenters/responders');

var _responders2 = _interopRequireDefault(_responders);

var _time = require('./endpoints/time');

var _time2 = _interopRequireDefault(_time);

var _presence = require('./endpoints/presence');

var _presence2 = _interopRequireDefault(_presence);

var _history = require('./endpoints/history');

var _history2 = _interopRequireDefault(_history);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var packageJSON = require('../../package.json');
var defaultConfiguration = require('../defaults.json');
var utils = require('./utils');

var NOW = 1;
var READY = false;
var READY_BUFFER = [];
var PRESENCE_SUFFIX = '-pnpres';
var DEF_WINDOWING = 10; // MILLISECONDS.
var DEF_TIMEOUT = 15000; // MILLISECONDS.
var DEF_SUB_TIMEOUT = 310; // SECONDS.
var DEF_KEEPALIVE = 60; // SECONDS (FOR TIMESYNC).
var SECOND = 1000; // A THOUSAND MILLISECONDS.
var PRESENCE_HB_THRESHOLD = 5;
var PRESENCE_HB_DEFAULT = 30;
var SDK_VER = packageJSON.version;

/**
 * UTILITIES
 */
function unique() {
  return 'x' + ++NOW + '' + +new Date();
}

// PUBNUB READY TO CONNECT
function ready() {
  if (READY) return;
  READY = 1;
  utils.each(READY_BUFFER, function (connect) {
    connect();
  });
}

function PNmessage(args) {
  var msg = args || { apns: {} };

  msg['getPubnubMessage'] = function () {
    var m = {};

    if (Object.keys(msg['apns']).length) {
      m['pn_apns'] = {
        aps: {
          alert: msg['apns']['alert'],
          badge: msg['apns']['badge']
        }
      };
      for (var k in msg['apns']) {
        m['pn_apns'][k] = msg['apns'][k];
      }
      var exclude1 = ['badge', 'alert'];
      for (var k in exclude1) {
        delete m['pn_apns'][exclude1[k]];
      }
    }

    if (msg['gcm']) {
      m['pn_gcm'] = {
        data: msg['gcm']
      };
    }

    for (var k in msg) {
      m[k] = msg[k];
    }
    var exclude = ['apns', 'gcm', 'publish', 'channel', 'callback', 'error'];
    for (var k in exclude) {
      delete m[exclude[k]];
    }

    return m;
  };
  msg['publish'] = function () {
    var m = msg.getPubnubMessage();

    if (msg['pubnub'] && msg['channel']) {
      msg['pubnub'].publish({
        message: m,
        channel: msg['channel'],
        callback: msg['callback'],
        error: msg['error']
      });
    }
  };
  return msg;
}

function PN_API(setup) {
  var jsonp_cb = setup.jsonp_cb || function () {
    return 0;
  };
  var xdr = setup.xdr;

  var db = setup.db || { get: function get() {}, set: function set() {} };
  var _error = setup.error || function () {};
  var crypto_obj = setup.crypto_obj || {
    encrypt: function encrypt(a, key) {
      return a;
    },
    decrypt: function decrypt(b, key) {
      return b;
    }
  };

  var keychain = new _keychain2.default().setInstanceId(_uuid2.default.v4()).setAuthKey(setup.auth_key || '').setSecretKey(setup.secret_key || '').setSubscribeKey(setup.subscribe_key).setPublishKey(setup.publish_key).setCipherKey(setup.cipher_key);

  keychain.setUUID(setup.uuid || !setup.unique_uuid && db.get(keychain.getSubscribeKey() + 'uuid') || _uuid2.default.v4());

  // write the new key to storage
  db.set(keychain.getSubscribeKey() + 'uuid', keychain.getUUID());

  var config = new _config2.default().setRequestIdConfig(setup.use_request_id || false).setInstanceIdConfig(setup.instance_id || false);

  var stateStorage = new _state2.default();

  var networking = new _networking2.default(setup.xdr, keychain, setup.ssl, setup.origin).setCoreParams(setup.params || {});

  // initialize the encryption and decryption logic
  function encrypt(input, key) {
    return crypto_obj.encrypt(input, key || keychain.getCipherKey()) || input;
  }

  function decrypt(input, key) {
    return crypto_obj['decrypt'](input, key || keychain.getCipherKey()) || crypto_obj['decrypt'](input, keychain.getCipherKey()) || input;
  }

  // initalize the endpoints
  var timeEndpoint = new _time2.default({ keychain: keychain, config: config, networking: networking, jsonp_cb: jsonp_cb });
  var presenceEndpoints = new _presence2.default({ keychain: keychain, config: config, networking: networking, jsonp_cb: jsonp_cb, error: _error });
  var historyEndpoint = new _history2.default({ keychain: keychain, networking: networking, jsonp_cb: jsonp_cb, error: _error, decrypt: decrypt });

  var SUB_WINDOWING = +setup['windowing'] || DEF_WINDOWING;
  var SUB_TIMEOUT = (+setup['timeout'] || DEF_SUB_TIMEOUT) * SECOND;
  var KEEPALIVE = (+setup['keepalive'] || DEF_KEEPALIVE) * SECOND;
  var TIME_CHECK = setup['timecheck'] || 0;
  var NOLEAVE = setup['noleave'] || 0;
  var hmac_SHA256 = setup['hmac_SHA256'];
  var SSL = setup['ssl'] ? 's' : '';
  var CONNECT = function CONNECT() {};
  var PUB_QUEUE = [];
  var CLOAK = true;
  var TIME_DRIFT = 0;
  var SUB_CALLBACK = 0;
  var SUB_CHANNEL = 0;
  var SUB_RECEIVER = 0;
  var SUB_RESTORE = setup['restore'] || 0;
  var SUB_BUFF_WAIT = 0;
  var TIMETOKEN = 0;
  var RESUMED = false;
  var SUB_ERROR = function SUB_ERROR() {};
  var STATE = {};
  var PRESENCE_HB_TIMEOUT = null;
  var PRESENCE_HB = validate_presence_heartbeat(setup['heartbeat'] || setup['pnexpires'] || 0, setup['error']);
  var PRESENCE_HB_INTERVAL = setup['heartbeat_interval'] || PRESENCE_HB / 2 - 1;
  var PRESENCE_HB_RUNNING = false;
  var NO_WAIT_FOR_PENDING = setup['no_wait_for_pending'];
  var COMPATIBLE_35 = setup['compatible_3.5'] || false;
  var _is_online = setup['_is_online'] || function () {
    return 1;
  };
  var _shutdown = setup['shutdown'];
  var use_send_beacon = typeof setup['use_send_beacon'] != 'undefined' ? setup['use_send_beacon'] : true;
  var sendBeacon = use_send_beacon ? setup['sendBeacon'] : null;
  var _poll_timer;
  var _poll_timer2;

  if (PRESENCE_HB === 2) PRESENCE_HB_INTERVAL = 1;

  function _object_to_key_list(o) {
    var l = [];
    utils.each(o, function (key, value) {
      l.push(key);
    });
    return l;
  }

  function _object_to_key_list_sorted(o) {
    return _object_to_key_list(o).sort();
  }

  function _get_pam_sign_input_from_params(params) {
    var si = '';
    var l = _object_to_key_list_sorted(params);

    for (var i in l) {
      var k = l[i];
      si += k + '=' + utils.pamEncode(params[k]);
      if (i != l.length - 1) si += '&';
    }
    return si;
  }

  function validate_presence_heartbeat(heartbeat, cur_heartbeat, error) {
    var err = false;

    if (typeof heartbeat === 'undefined') {
      return cur_heartbeat;
    }

    if (typeof heartbeat === 'number') {
      if (heartbeat > PRESENCE_HB_THRESHOLD || heartbeat == 0) {
        err = false;
      } else {
        err = true;
      }
    } else if (typeof heartbeat === 'boolean') {
      if (!heartbeat) {
        return 0;
      } else {
        return PRESENCE_HB_DEFAULT;
      }
    } else {
      err = true;
    }

    if (err) {
      error && error('Presence Heartbeat value invalid. Valid range ( x > ' + PRESENCE_HB_THRESHOLD + ' or x = 0). Current Value : ' + (cur_heartbeat || PRESENCE_HB_THRESHOLD));
      return cur_heartbeat || PRESENCE_HB_THRESHOLD;
    } else return heartbeat;
  }

  function error_common(message, callback) {
    callback && callback({ error: message || 'error occurred' });
    _error && _error(message);
  }

  function _presence_heartbeat() {
    clearTimeout(PRESENCE_HB_TIMEOUT);

    if (!PRESENCE_HB_INTERVAL || PRESENCE_HB_INTERVAL >= 500 || PRESENCE_HB_INTERVAL < 1 || !stateStorage.generate_channel_list(true).length && !stateStorage.generate_channel_group_list(true).length) {
      PRESENCE_HB_RUNNING = false;
      return;
    }

    PRESENCE_HB_RUNNING = true;
    SELF['presence_heartbeat']({
      callback: function callback(r) {
        PRESENCE_HB_TIMEOUT = utils.timeout(_presence_heartbeat, PRESENCE_HB_INTERVAL * SECOND);
      },
      error: function error(e) {
        _error && _error('Presence Heartbeat unable to reach Pubnub servers.' + JSON.stringify(e));
        PRESENCE_HB_TIMEOUT = utils.timeout(_presence_heartbeat, PRESENCE_HB_INTERVAL * SECOND);
      }
    });
  }

  function start_presence_heartbeat() {
    !PRESENCE_HB_RUNNING && _presence_heartbeat();
  }

  function _publish(next) {
    if (NO_WAIT_FOR_PENDING) {
      if (!PUB_QUEUE.length) return;
    } else {
      if (next) PUB_QUEUE.sending = 0;
      if (PUB_QUEUE.sending || !PUB_QUEUE.length) return;
      PUB_QUEUE.sending = 1;
    }

    xdr(PUB_QUEUE.shift());
  }

  function each_channel_group(callback) {
    var count = 0;

    utils.each(stateStorage.generate_channel_group_list(), function (channel_group) {
      var chang = stateStorage.getChannelGroup(channel_group);

      if (!chang) return;

      count++;
      (callback || function () {})(chang);
    });

    return count;
  }

  function each_channel(callback) {
    var count = 0;

    utils.each(stateStorage.generate_channel_list(), function (channel) {
      var chan = stateStorage.getChannel(channel);

      if (!chan) return;

      count++;
      (callback || function () {})(chan);
    });

    return count;
  }

  function CR(args, callback, url1, data) {
    var callback = args['callback'] || callback;
    var err = args['error'] || _error;
    var jsonp = jsonp_cb();

    data = data || {};

    if (!data['auth']) {
      data['auth'] = args['auth_key'] || keychain.getAuthKey();
    }

    var url = [networking.getStandardOrigin(), 'v1', 'channel-registration', 'sub-key', keychain.getSubscribeKey()];

    url.push.apply(url, url1);

    if (jsonp) data['callback'] = jsonp;

    xdr({
      callback: jsonp,
      data: networking.prepareParams(data),
      success: function success(response) {
        _responders2.default.callback(response, callback, err);
      },
      fail: function fail(response) {
        _responders2.default.error(response, err);
      },
      url: url
    });
  }

  // Announce Leave Event
  var SELF = {
    LEAVE: function LEAVE(channel, blocking, auth_key, callback, error) {
      var data = { uuid: keychain.getUUID(), auth: auth_key || keychain.getAuthKey() };
      var origin = networking.nextOrigin(false);
      var callback = callback || function () {};
      var err = error || function () {};
      var url;
      var params;
      var jsonp = jsonp_cb();

      // Prevent Leaving a Presence Channel
      if (channel.indexOf(PRESENCE_SUFFIX) > 0) return true;

      if (COMPATIBLE_35) {
        if (!SSL) return false;
        if (jsonp == '0') return false;
      }

      if (NOLEAVE) return false;

      if (jsonp != '0') data['callback'] = jsonp;

      if (config.isInstanceIdEnabled()) {
        data['instanceid'] = keychain.getInstanceId();
      }

      url = [origin, 'v2', 'presence', 'sub_key', keychain.getSubscribeKey(), 'channel', utils.encode(channel), 'leave'];

      params = networking.prepareParams(data);

      if (sendBeacon) {
        var url_string = utils.buildURL(url, params);
        if (sendBeacon(url_string)) {
          callback && callback({ status: 200, action: 'leave', message: 'OK', service: 'Presence' });
          return true;
        }
      }

      xdr({
        blocking: blocking || SSL,
        callback: jsonp,
        data: params,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: url
      });
      return true;
    },

    LEAVE_GROUP: function LEAVE_GROUP(channel_group, blocking, auth_key, callback, error) {
      var data = { uuid: keychain.getUUID(), auth: auth_key || keychain.getAuthKey() };
      var origin = networking.nextOrigin(false);
      var url;
      var params;
      var callback = callback || function () {};
      var err = error || function () {};
      var jsonp = jsonp_cb();

      // Prevent Leaving a Presence Channel Group
      if (channel_group.indexOf(PRESENCE_SUFFIX) > 0) return true;

      if (COMPATIBLE_35) {
        if (!SSL) return false;
        if (jsonp == '0') return false;
      }

      if (NOLEAVE) return false;

      if (jsonp != '0') data['callback'] = jsonp;

      if (channel_group && channel_group.length > 0) data['channel-group'] = channel_group;

      if (config.isInstanceIdEnabled()) {
        data['instanceid'] = keychain.getInstanceId();
      }

      url = [origin, 'v2', 'presence', 'sub_key', keychain.getSubscribeKey(), 'channel', utils.encode(','), 'leave'];

      params = networking.prepareParams(data);

      if (sendBeacon) {
        var url_string = utils.buildURL(url, params);
        if (sendBeacon(url_string)) {
          callback && callback({ status: 200, action: 'leave', message: 'OK', service: 'Presence' });
          return true;
        }
      }

      xdr({
        blocking: blocking || SSL,
        callback: jsonp,
        data: params,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: url
      });
      return true;
    },

    set_resumed: function set_resumed(resumed) {
      RESUMED = resumed;
    },

    get_cipher_key: function get_cipher_key() {
      return keychain.getCipherKey();
    },

    set_cipher_key: function set_cipher_key(key) {
      keychain.setCipherKey(key);
    },

    raw_encrypt: function raw_encrypt(input, key) {
      return encrypt(input, key);
    },

    raw_decrypt: function raw_decrypt(input, key) {
      return decrypt(input, key);
    },

    get_heartbeat: function get_heartbeat() {
      return PRESENCE_HB;
    },

    set_heartbeat: function set_heartbeat(heartbeat, heartbeat_interval) {
      PRESENCE_HB = validate_presence_heartbeat(heartbeat, PRESENCE_HB, _error);
      PRESENCE_HB_INTERVAL = heartbeat_interval || PRESENCE_HB / 2 - 1;
      if (PRESENCE_HB == 2) {
        PRESENCE_HB_INTERVAL = 1;
      }
      CONNECT();
      _presence_heartbeat();
    },

    get_heartbeat_interval: function get_heartbeat_interval() {
      return PRESENCE_HB_INTERVAL;
    },

    set_heartbeat_interval: function set_heartbeat_interval(heartbeat_interval) {
      PRESENCE_HB_INTERVAL = heartbeat_interval;
      _presence_heartbeat();
    },

    get_version: function get_version() {
      return SDK_VER;
    },

    getGcmMessageObject: function getGcmMessageObject(obj) {
      return {
        data: obj
      };
    },

    getApnsMessageObject: function getApnsMessageObject(obj) {
      var x = {
        aps: { badge: 1, alert: '' }
      };
      for (var k in obj) {
        k[x] = obj[k];
      }
      return x;
    },

    _add_param: function _add_param(key, val) {
      networking.addCoreParam(key, val);
    },

    channel_group: function channel_group(args, callback) {
      var ns_ch = args['channel_group'];
      var callback = callback || args['callback'];
      var channels = args['channels'] || args['channel'];
      var cloak = args['cloak'];
      var namespace;
      var channel_group;
      var url = [];
      var data = {};
      var mode = args['mode'] || 'add';

      if (ns_ch) {
        var ns_ch_a = ns_ch.split(':');

        if (ns_ch_a.length > 1) {
          namespace = ns_ch_a[0] === '*' ? null : ns_ch_a[0];

          channel_group = ns_ch_a[1];
        } else {
          channel_group = ns_ch_a[0];
        }
      }

      namespace && url.push('namespace') && url.push(utils.encode(namespace));

      url.push('channel-group');

      if (channel_group && channel_group !== '*') {
        url.push(channel_group);
      }

      if (channels) {
        if (utils.isArray(channels)) {
          channels = channels.join(',');
        }
        data[mode] = channels;
        data['cloak'] = CLOAK ? 'true' : 'false';
      } else {
        if (mode === 'remove') url.push('remove');
      }

      if (typeof cloak != 'undefined') data['cloak'] = cloak ? 'true' : 'false';

      CR(args, callback, url, data);
    },

    channel_group_list_groups: function channel_group_list_groups(args, callback) {
      var namespace;

      namespace = args['namespace'] || args['ns'] || args['channel_group'] || null;
      if (namespace) {
        args['channel_group'] = namespace + ':*';
      }

      SELF['channel_group'](args, callback);
    },

    channel_group_list_channels: function channel_group_list_channels(args, callback) {
      if (!args['channel_group']) return _error('Missing Channel Group');
      SELF['channel_group'](args, callback);
    },

    channel_group_remove_channel: function channel_group_remove_channel(args, callback) {
      if (!args['channel_group']) return _error('Missing Channel Group');
      if (!args['channel'] && !args['channels']) return _error('Missing Channel');

      args['mode'] = 'remove';
      SELF['channel_group'](args, callback);
    },

    channel_group_remove_group: function channel_group_remove_group(args, callback) {
      if (!args['channel_group']) return _error('Missing Channel Group');
      if (args['channel']) return _error('Use channel_group_remove_channel if you want to remove a channel from a group.');

      args['mode'] = 'remove';
      SELF['channel_group'](args, callback);
    },

    channel_group_add_channel: function channel_group_add_channel(args, callback) {
      if (!args['channel_group']) return _error('Missing Channel Group');
      if (!args['channel'] && !args['channels']) return _error('Missing Channel');
      SELF['channel_group'](args, callback);
    },

    channel_group_cloak: function channel_group_cloak(args, callback) {
      if (typeof args['cloak'] == 'undefined') {
        callback(CLOAK);
        return;
      }
      CLOAK = args['cloak'];
      SELF['channel_group'](args, callback);
    },

    channel_group_list_namespaces: function channel_group_list_namespaces(args, callback) {
      var url = ['namespace'];
      CR(args, callback, url);
    },

    channel_group_remove_namespace: function channel_group_remove_namespace(args, callback) {
      var url = ['namespace', args['namespace'], 'remove'];
      CR(args, callback, url);
    },

    /*
     PUBNUB.history({
     channel  : 'my_chat_channel',
     limit    : 100,
     callback : function(history) { }
     });
     */
    history: function history(args, callback) {
      historyEndpoint.fetchHistory(args, callback);
    },

    /*
     PUBNUB.replay({
     source      : 'my_channel',
     destination : 'new_channel'
     });
     */
    replay: function replay(args, callback) {
      var callback = callback || args['callback'] || function () {};
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var source = args['source'];
      var destination = args['destination'];
      var err = args['error'] || args['error'] || function () {};
      var stop = args['stop'];
      var start = args['start'];
      var end = args['end'];
      var reverse = args['reverse'];
      var limit = args['limit'];
      var jsonp = jsonp_cb();
      var data = {};
      var url;

      // Check User Input
      if (!source) return _error('Missing Source Channel');
      if (!destination) return _error('Missing Destination Channel');
      if (!keychain.getPublishKey()) return _error('Missing Publish Key');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      // Setup URL Params
      if (jsonp != '0') data['callback'] = jsonp;
      if (stop) data['stop'] = 'all';
      if (reverse) data['reverse'] = 'true';
      if (start) data['start'] = start;
      if (end) data['end'] = end;
      if (limit) data['count'] = limit;

      data['auth'] = auth_key;

      // Start (or Stop) Replay!
      networking.fetchReplay(source, destination, {
        callback: jsonp,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail() {
          callback([0, 'Disconnected']);
        },
        data: networking.prepareParams(data)
      });
    },

    /*
     PUBNUB.auth('AJFLKAJSDKLA');
     */
    auth: function auth(_auth) {
      keychain.setAuthKey(_auth);
      CONNECT();
    },

    /*
     PUBNUB.time(function(time){ });
     */
    time: function time(callback) {
      timeEndpoint.fetchTime(callback);
    },

    /*
     PUBNUB.publish({
     channel : 'my_chat_channel',
     message : 'hello!'
     });
     */
    publish: function publish(args, callback) {
      var msg = args['message'];
      if (!msg) return _error('Missing Message');

      var callback = callback || args['callback'] || msg['callback'] || args['success'] || function () {};
      var channel = args['channel'] || msg['channel'];
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var cipher_key = args['cipher_key'];
      var err = args['error'] || msg['error'] || function () {};
      var post = args['post'] || false;
      var store = 'store_in_history' in args ? args['store_in_history'] : true;
      var jsonp = jsonp_cb();
      var add_msg = 'push';
      var params = { uuid: keychain.getUUID(), auth: auth_key };
      var url;

      if (args['prepend']) add_msg = 'unshift';

      if (!channel) return _error('Missing Channel');
      if (!keychain.getPublishKey()) return _error('Missing Publish Key');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      if (msg['getPubnubMessage']) {
        msg = msg['getPubnubMessage']();
      }

      // If trying to send Object
      msg = JSON.stringify(encrypt(msg, cipher_key));

      // Create URL
      url = [networking.getStandardOrigin(), 'publish', keychain.getPublishKey(), keychain.getSubscribeKey(), 0, utils.encode(channel), jsonp, utils.encode(msg)];

      if (!store) params['store'] = '0';

      if (config.isInstanceIdEnabled()) {
        params['instanceid'] = keychain.getInstanceId();
      }

      // Queue Message Send
      PUB_QUEUE[add_msg]({
        callback: jsonp,
        url: url,
        data: networking.prepareParams(params),
        fail: function fail(response) {
          _responders2.default.error(response, err);
          _publish(1);
        },
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
          _publish(1);
        },
        mode: post ? 'POST' : 'GET'
      });

      // Send Message
      _publish();
    },

    /*
     PUBNUB.unsubscribe({ channel : 'my_chat' });
     */
    unsubscribe: function unsubscribe(args, callback) {
      var channelArg = args['channel'];
      var channelGroupArg = args['channel_group'];
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var callback = callback || args['callback'] || function () {};
      var err = args['error'] || function () {};

      TIMETOKEN = 0;
      SUB_RESTORE = 1; // REVISIT !!!!

      if (!channelArg && !channelGroupArg) return _error('Missing Channel or Channel Group');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      if (channelArg) {
        var channels = utils.isArray(channelArg) ? channelArg : ('' + channelArg).split(',');
        var existingChannels = [];
        var presenceChannels = [];

        utils.each(channels, function (channel) {
          if (stateStorage.getChannel(channel)) existingChannels.push(channel);
        });

        // if we do not have any channels to unsubscribe from, trigger a callback.
        if (existingChannels.length == 0) {
          callback({ action: 'leave' });
          return;
        }

        // Prepare presence channels
        utils.each(existingChannels, function (channel) {
          presenceChannels.push(channel + PRESENCE_SUFFIX);
        });

        utils.each(existingChannels.concat(presenceChannels), function (channel) {
          if (stateStorage.containsChannel(channel)) stateStorage.addChannel(channel, 0);
          if (channel in STATE) delete STATE[channel];
        });

        var CB_CALLED = true;
        if (READY) {
          CB_CALLED = SELF['LEAVE'](existingChannels.join(','), 0, auth_key, callback, err);
        }
        if (!CB_CALLED) callback({ action: 'leave' });
      }

      if (channelGroupArg) {
        var channelGroups = utils.isArray(channelGroupArg) ? channelGroupArg : ('' + channelGroupArg).split(',');
        var existingChannelGroups = [];
        var presenceChannelGroups = [];

        utils.each(channelGroups, function (channelGroup) {
          if (stateStorage.getChannelGroup(channelGroup)) existingChannelGroups.push(channelGroup);
        });

        // if we do not have any channel groups to unsubscribe from, trigger a callback.
        if (existingChannelGroups.length == 0) {
          callback({ action: 'leave' });
          return;
        }

        // Prepare presence channels
        utils.each(existingChannelGroups, function (channelGroup) {
          presenceChannelGroups.push(channelGroup + PRESENCE_SUFFIX);
        });

        utils.each(existingChannelGroups.concat(presenceChannelGroups), function (channelGroup) {
          if (stateStorage.containsChannelGroup(channelGroup)) stateStorage.addChannelGroup(channelGroup, 0);
          if (channelGroup in STATE) delete STATE[channelGroup];
        });

        var CB_CALLED = true;
        if (READY) {
          CB_CALLED = SELF['LEAVE_GROUP'](existingChannelGroups.join(','), 0, auth_key, callback, err);
        }
        if (!CB_CALLED) callback({ action: 'leave' });
      }

      // Reset Connection if Count Less
      CONNECT();
    },

    /*
     PUBNUB.subscribe({
     channel  : 'my_chat'
     callback : function(message) { }
     });
     */
    subscribe: function subscribe(args, callback) {
      var channel = args['channel'];
      var channel_group = args['channel_group'];
      var callback = callback || args['callback'];
      var callback = callback || args['message'];
      var connect = args['connect'] || function () {};
      var reconnect = args['reconnect'] || function () {};
      var disconnect = args['disconnect'] || function () {};
      var SUB_ERROR = args['error'] || SUB_ERROR || function () {};
      var idlecb = args['idle'] || function () {};
      var presence = args['presence'] || 0;
      var noheresync = args['noheresync'] || 0;
      var backfill = args['backfill'] || 0;
      var timetoken = args['timetoken'] || 0;
      var sub_timeout = args['timeout'] || SUB_TIMEOUT;
      var windowing = args['windowing'] || SUB_WINDOWING;
      var state = args['state'];
      var heartbeat = args['heartbeat'] || args['pnexpires'];
      var heartbeat_interval = args['heartbeat_interval'];
      var restore = args['restore'] || SUB_RESTORE;

      keychain.setAuthKey(args['auth_key'] || keychain.getAuthKey());

      // Restore Enabled?
      SUB_RESTORE = restore;

      // Always Reset the TT
      TIMETOKEN = timetoken;

      // Make sure we have a Channel
      if (!channel && !channel_group) {
        return _error('Missing Channel');
      }

      if (!callback) return _error('Missing Callback');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      if (heartbeat || heartbeat === 0 || heartbeat_interval || heartbeat_interval === 0) {
        SELF['set_heartbeat'](heartbeat, heartbeat_interval);
      }

      // Setup Channel(s)
      if (channel) {
        utils.each((channel.join ? channel.join(',') : '' + channel).split(','), function (channel) {
          var settings = stateStorage.getChannel(channel) || {};

          // Store Channel State
          stateStorage.addChannel(SUB_CHANNEL = channel, {
            name: channel,
            connected: settings.connected,
            disconnected: settings.disconnected,
            subscribed: 1,
            callback: SUB_CALLBACK = callback,
            cipher_key: args['cipher_key'],
            connect: connect,
            disconnect: disconnect,
            reconnect: reconnect
          });

          if (state) {
            if (channel in state) {
              STATE[channel] = state[channel];
            } else {
              STATE[channel] = state;
            }
          }

          // Presence Enabled?
          if (!presence) return;

          // Subscribe Presence Channel
          SELF['subscribe']({
            channel: channel + PRESENCE_SUFFIX,
            callback: presence,
            restore: restore
          });

          // Presence Subscribed?
          if (settings.subscribed) return;

          // See Who's Here Now?
          if (noheresync) return;
          SELF['here_now']({
            channel: channel,
            data: networking.prepareParams({ uuid: keychain.getUUID(), auth: keychain.getAuthKey() }),
            callback: function callback(here) {
              utils.each('uuids' in here ? here['uuids'] : [], function (uid) {
                presence({
                  action: 'join',
                  uuid: uid,
                  timestamp: Math.floor(utils.rnow() / 1000),
                  occupancy: here['occupancy'] || 1
                }, here, channel);
              });
            }
          });
        });
      }

      // Setup Channel Groups
      if (channel_group) {
        utils.each((channel_group.join ? channel_group.join(',') : '' + channel_group).split(','), function (channel_group) {
          var settings = stateStorage.getChannelGroup(channel_group) || {};

          stateStorage.addChannelGroup(channel_group, {
            name: channel_group,
            connected: settings.connected,
            disconnected: settings.disconnected,
            subscribed: 1,
            callback: SUB_CALLBACK = callback,
            cipher_key: args['cipher_key'],
            connect: connect,
            disconnect: disconnect,
            reconnect: reconnect
          });

          // Presence Enabled?
          if (!presence) return;

          // Subscribe Presence Channel
          SELF['subscribe']({
            channel_group: channel_group + PRESENCE_SUFFIX,
            callback: presence,
            restore: restore,
            auth_key: keychain.getAuthKey()
          });

          // Presence Subscribed?
          if (settings.subscribed) return;

          // See Who's Here Now?
          if (noheresync) return;
          SELF['here_now']({
            channel_group: channel_group,
            data: networking.prepareParams({ uuid: keychain.getUUID(), auth: keychain.getAuthKey() }),
            callback: function callback(here) {
              utils.each('uuids' in here ? here['uuids'] : [], function (uid) {
                presence({
                  action: 'join',
                  uuid: uid,
                  timestamp: Math.floor(utils.rnow() / 1000),
                  occupancy: here['occupancy'] || 1
                }, here, channel_group);
              });
            }
          });
        });
      }

      // Test Network Connection
      function _test_connection(success) {
        if (success) {
          // Begin Next Socket Connection
          utils.timeout(CONNECT, windowing);
        } else {
          // New Origin on Failed Connection
          networking.shiftStandardOrigin(true);
          networking.shiftSubscribeOrigin(true);

          // Re-test Connection
          utils.timeout(function () {
            SELF['time'](_test_connection);
          }, SECOND);
        }

        // Disconnect & Reconnect
        each_channel(function (channel) {
          // Reconnect
          if (success && channel.disconnected) {
            channel.disconnected = 0;
            return channel.reconnect(channel.name);
          }

          // Disconnect
          if (!success && !channel.disconnected) {
            channel.disconnected = 1;
            channel.disconnect(channel.name);
          }
        });

        // Disconnect & Reconnect for channel groups
        each_channel_group(function (channel_group) {
          // Reconnect
          if (success && channel_group.disconnected) {
            channel_group.disconnected = 0;
            return channel_group.reconnect(channel_group.name);
          }

          // Disconnect
          if (!success && !channel_group.disconnected) {
            channel_group.disconnected = 1;
            channel_group.disconnect(channel_group.name);
          }
        });
      }

      // Evented Subscribe
      function _connect() {
        var jsonp = jsonp_cb();
        var channels = stateStorage.generate_channel_list().join(',');
        var channel_groups = stateStorage.generate_channel_group_list().join(',');

        // Stop Connection
        if (!channels && !channel_groups) return;

        if (!channels) channels = ',';

        // Connect to PubNub Subscribe Servers
        _reset_offline();

        var data = networking.prepareParams({ uuid: keychain.getUUID(), auth: keychain.getAuthKey() });

        if (channel_groups) {
          data['channel-group'] = channel_groups;
        }

        var st = JSON.stringify(STATE);
        if (st.length > 2) data['state'] = JSON.stringify(STATE);

        if (PRESENCE_HB) data['heartbeat'] = PRESENCE_HB;

        if (config.isInstanceIdEnabled()) {
          data['instanceid'] = keychain.getInstanceId();
        }

        start_presence_heartbeat();
        SUB_RECEIVER = xdr({
          timeout: sub_timeout,
          callback: jsonp,
          fail: function fail(response) {
            if (response && response['error'] && response['service']) {
              _responders2.default.error(response, SUB_ERROR);
              _test_connection(false);
            } else {
              SELF['time'](function (success) {
                !success && _responders2.default.error(response, SUB_ERROR);
                _test_connection(success);
              });
            }
          },
          data: networking.prepareParams(data),
          url: [networking.getSubscribeOrigin(), 'subscribe', keychain.getSubscribeKey(), utils.encode(channels), jsonp, TIMETOKEN],
          success: function success(messages) {
            // Check for Errors
            if (!messages || (typeof messages === 'undefined' ? 'undefined' : _typeof(messages)) == 'object' && 'error' in messages && messages['error']) {
              SUB_ERROR(messages);
              return utils.timeout(CONNECT, SECOND);
            }

            // User Idle Callback
            idlecb(messages[1]);

            // Restore Previous Connection Point if Needed
            TIMETOKEN = !TIMETOKEN && SUB_RESTORE && db['get'](keychain.getSubscribeKey()) || messages[1];

            /*
             // Connect
             each_channel_registry(function(registry){
             if (registry.connected) return;
             registry.connected = 1;
             registry.connect(channel.name);
             });
             */

            // Connect
            each_channel(function (channel) {
              if (channel.connected) return;
              channel.connected = 1;
              channel.connect(channel.name);
            });

            // Connect for channel groups
            each_channel_group(function (channel_group) {
              if (channel_group.connected) return;
              channel_group.connected = 1;
              channel_group.connect(channel_group.name);
            });

            if (RESUMED && !SUB_RESTORE) {
              TIMETOKEN = 0;
              RESUMED = false;
              // Update Saved Timetoken
              db['set'](keychain.getSubscribeKey(), 0);
              utils.timeout(_connect, windowing);
              return;
            }

            // Invoke Memory Catchup and Receive Up to 100
            // Previous Messages from the Queue.
            if (backfill) {
              TIMETOKEN = 10000;
              backfill = 0;
            }

            // Update Saved Timetoken
            db['set'](keychain.getSubscribeKey(), messages[1]);

            // Route Channel <---> Callback for Message
            var next_callback = function () {
              var channels = '';
              var channels2 = '';

              if (messages.length > 3) {
                channels = messages[3];
                channels2 = messages[2];
              } else if (messages.length > 2) {
                channels = messages[2];
              } else {
                channels = utils.map(stateStorage.generate_channel_list(), function (chan) {
                  return utils.map(Array(messages[0].length).join(',').split(','), function () {
                    return chan;
                  });
                }).join(',');
              }

              var list = channels.split(',');
              var list2 = channels2 ? channels2.split(',') : [];

              return function () {
                var channel = list.shift() || SUB_CHANNEL;
                var channel2 = list2.shift();

                var chobj = {};

                if (channel2) {
                  if (channel && channel.indexOf('-pnpres') >= 0 && channel2.indexOf('-pnpres') < 0) {
                    channel2 += '-pnpres';
                  }
                  chobj = stateStorage.getChannelGroup(channel2) || stateStorage.getChannel(channel2) || { callback: function callback() {} };
                } else {
                  chobj = stateStorage.getChannel(channel);
                }

                var r = [chobj.callback || SUB_CALLBACK, channel.split(PRESENCE_SUFFIX)[0]];
                channel2 && r.push(channel2.split(PRESENCE_SUFFIX)[0]);
                return r;
              };
            }();

            var latency = detect_latency(+messages[1]);
            utils.each(messages[0], function (msg) {
              var next = next_callback();
              var decrypted_msg = decrypt(msg, stateStorage.getChannel(next[1]) ? stateStorage.getChannel(next[1])['cipher_key'] : null);
              next[0] && next[0](decrypted_msg, messages, next[2] || next[1], latency, next[1]);
            });

            utils.timeout(_connect, windowing);
          }
        });
      }

      CONNECT = function CONNECT() {
        _reset_offline();
        utils.timeout(_connect, windowing);
      };

      // Reduce Status Flicker
      if (!READY) return READY_BUFFER.push(CONNECT);

      // Connect Now
      CONNECT();
    },

    /*
     PUBNUB.here_now({ channel : 'my_chat', callback : fun });
     */
    here_now: function here_now(args, callback) {
      var callback = args['callback'] || callback;
      var debug = args['debug'];
      var err = args['error'] || function () {};
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var channel = args['channel'];
      var channel_group = args['channel_group'];
      var jsonp = jsonp_cb();
      var uuids = 'uuids' in args ? args['uuids'] : true;
      var state = args['state'];
      var data = { uuid: keychain.getUUID(), auth: auth_key };

      if (!uuids) data['disable_uuids'] = 1;
      if (state) data['state'] = 1;

      // Make sure we have a Channel
      if (!callback) return _error('Missing Callback');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      var url = [networking.getStandardOrigin(), 'v2', 'presence', 'sub_key', keychain.getSubscribeKey()];

      channel && url.push('channel') && url.push(utils.encode(channel));

      if (jsonp != '0') {
        data['callback'] = jsonp;
      }

      if (channel_group) {
        data['channel-group'] = channel_group;
        !channel && url.push('channel') && url.push(',');
      }

      if (config.isInstanceIdEnabled()) {
        data['instanceid'] = keychain.getInstanceId();
      }

      xdr({
        callback: jsonp,
        data: networking.prepareParams(data),
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        debug: debug,
        url: url
      });
    },

    /*
     PUBNUB.current_channels_by_uuid({ channel : 'my_chat', callback : fun });
     */
    where_now: function where_now(args, callback) {
      presenceEndpoints.whereNow(args, callback);
    },

    state: function state(args, callback) {
      var callback = args['callback'] || callback || function (r) {};
      var err = args['error'] || function () {};
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var jsonp = jsonp_cb();
      var state = args['state'];
      var uuid = args['uuid'] || keychain.getUUID();
      var channel = args['channel'];
      var channel_group = args['channel_group'];
      var url;
      var data = networking.prepareParams({ auth: auth_key });

      // Make sure we have a Channel
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');
      if (!uuid) return _error('Missing UUID');
      if (!channel && !channel_group) return _error('Missing Channel');

      if (jsonp != '0') {
        data['callback'] = jsonp;
      }

      if (typeof channel != 'undefined' && stateStorage.getChannel(channel) && stateStorage.getChannel(channel).subscribed) {
        if (state) STATE[channel] = state;
      }

      if (typeof channel_group != 'undefined' && stateStorage.getChannelGroup(channel_group) && stateStorage.getChannelGroup(channel_group).subscribed) {
        if (state) STATE[channel_group] = state;
        data['channel-group'] = channel_group;

        if (!channel) {
          channel = ',';
        }
      }

      data['state'] = JSON.stringify(state);

      if (config.isInstanceIdEnabled()) {
        data['instanceid'] = keychain.getInstanceId();
      }

      if (state) {
        url = [networking.getStandardOrigin(), 'v2', 'presence', 'sub-key', keychain.getSubscribeKey(), 'channel', channel, 'uuid', uuid, 'data'];
      } else {
        url = [networking.getStandardOrigin(), 'v2', 'presence', 'sub-key', keychain.getSubscribeKey(), 'channel', channel, 'uuid', utils.encode(uuid)];
      }

      xdr({
        callback: jsonp,
        data: networking.prepareParams(data),
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: url

      });
    },

    /*
     PUBNUB.grant({
     channel  : 'my_chat',
     callback : fun,
     error    : fun,
     ttl      : 24 * 60, // Minutes
     read     : true,
     write    : true,
     auth_key : '3y8uiajdklytowsj'
     });
     */
    grant: function grant(args, callback) {
      var callback = args['callback'] || callback;
      var err = args['error'] || function () {};
      var channel = args['channel'] || args['channels'];
      var channel_group = args['channel_group'];
      var jsonp = jsonp_cb();
      var ttl = args['ttl'];
      var r = args['read'] ? '1' : '0';
      var w = args['write'] ? '1' : '0';
      var m = args['manage'] ? '1' : '0';
      var auth_key = args['auth_key'] || args['auth_keys'];

      if (!callback) return _error('Missing Callback');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');
      if (!keychain.getPublishKey()) return _error('Missing Publish Key');
      if (!keychain.getSecretKey()) return _error('Missing Secret Key');

      var timestamp = Math.floor(new Date().getTime() / 1000);
      var sign_input = keychain.getSubscribeKey() + '\n' + keychain.getPublishKey() + '\n' + 'grant' + '\n';

      var data = { w: w, r: r, timestamp: timestamp };

      if (args['manage']) {
        data['m'] = m;
      }
      if (utils.isArray(channel)) {
        channel = channel['join'](',');
      }
      if (utils.isArray(auth_key)) {
        auth_key = auth_key['join'](',');
      }
      if (typeof channel != 'undefined' && channel != null && channel.length > 0) data['channel'] = channel;
      if (typeof channel_group != 'undefined' && channel_group != null && channel_group.length > 0) {
        data['channel-group'] = channel_group;
      }
      if (jsonp != '0') {
        data['callback'] = jsonp;
      }
      if (ttl || ttl === 0) data['ttl'] = ttl;

      if (auth_key) data['auth'] = auth_key;

      data = networking.prepareParams(data);

      if (!auth_key) delete data['auth'];

      sign_input += _get_pam_sign_input_from_params(data);

      var signature = hmac_SHA256(sign_input, keychain.getSecretKey());

      signature = signature.replace(/\+/g, '-');
      signature = signature.replace(/\//g, '_');

      data['signature'] = signature;

      xdr({
        callback: jsonp,
        data: data,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: [networking.getStandardOrigin(), 'v1', 'auth', 'grant', 'sub-key', keychain.getSubscribeKey()]
      });
    },

    /*
     PUBNUB.mobile_gw_provision ({
     device_id: 'A655FBA9931AB',
     op       : 'add' | 'remove',
     gw_type  : 'apns' | 'gcm',
     channel  : 'my_chat',
     callback : fun,
     error    : fun,
     });
     */

    mobile_gw_provision: function mobile_gw_provision(args) {
      var callback = args['callback'] || function () {};
      var auth_key = args['auth_key'] || keychain.getAuthKey();
      var err = args['error'] || function () {};
      var jsonp = jsonp_cb();
      var channel = args['channel'];
      var op = args['op'];
      var gw_type = args['gw_type'];
      var device_id = args['device_id'];
      var url;

      if (!device_id) return _error('Missing Device ID (device_id)');
      if (!gw_type) return _error('Missing GW Type (gw_type: gcm or apns)');
      if (!op) return _error('Missing GW Operation (op: add or remove)');
      if (!channel) return _error('Missing gw destination Channel (channel)');
      if (!keychain.getPublishKey()) return _error('Missing Publish Key');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');

      var params = { uuid: keychain.getUUID(), auth: auth_key, type: gw_type };

      // Create URL
      url = [networking.getStandardOrigin(), 'v1/push/sub-key', keychain.getSubscribeKey(), 'devices', device_id];

      if (op == 'add') {
        params['add'] = channel;
      } else if (op == 'remove') {
        params['remove'] = channel;
      }

      if (config.isInstanceIdEnabled()) {
        params['instanceid'] = keychain.getInstanceId();
      }

      xdr({
        callback: jsonp,
        data: params,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: url
      });
    },

    /*
     PUBNUB.audit({
     channel  : 'my_chat',
     callback : fun,
     error    : fun,
     read     : true,
     write    : true,
     auth_key : '3y8uiajdklytowsj'
     });
     */
    audit: function audit(args, callback) {
      var callback = args['callback'] || callback;
      var err = args['error'] || function () {};
      var channel = args['channel'];
      var channel_group = args['channel_group'];
      var auth_key = args['auth_key'];
      var jsonp = jsonp_cb();

      // Make sure we have a Channel
      if (!callback) return _error('Missing Callback');
      if (!keychain.getSubscribeKey()) return _error('Missing Subscribe Key');
      if (!keychain.getPublishKey()) return _error('Missing Publish Key');
      if (!keychain.getSecretKey()) return _error('Missing Secret Key');

      var timestamp = Math.floor(new Date().getTime() / 1000);
      var sign_input = keychain.getSubscribeKey() + '\n' + keychain.getPublishKey() + '\n' + 'audit' + '\n';

      var data = { timestamp: timestamp };
      if (jsonp != '0') {
        data['callback'] = jsonp;
      }
      if (typeof channel != 'undefined' && channel != null && channel.length > 0) data['channel'] = channel;
      if (typeof channel_group != 'undefined' && channel_group != null && channel_group.length > 0) {
        data['channel-group'] = channel_group;
      }
      if (auth_key) data['auth'] = auth_key;

      data = networking.prepareParams(data);

      if (!auth_key) delete data['auth'];

      sign_input += _get_pam_sign_input_from_params(data);

      var signature = hmac_SHA256(sign_input, keychain.getSecretKey());

      signature = signature.replace(/\+/g, '-');
      signature = signature.replace(/\//g, '_');

      data['signature'] = signature;
      xdr({
        callback: jsonp,
        data: data,
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        },
        url: [networking.getStandardOrigin(), 'v1', 'auth', 'audit', 'sub-key', keychain.getSubscribeKey()]
      });
    },

    /*
     PUBNUB.revoke({
     channel  : 'my_chat',
     callback : fun,
     error    : fun,
     auth_key : '3y8uiajdklytowsj'
     });
     */
    revoke: function revoke(args, callback) {
      args['read'] = false;
      args['write'] = false;
      SELF['grant'](args, callback);
    },

    set_uuid: function set_uuid(uuid) {
      keychain.setUUID(uuid);
      CONNECT();
    },

    get_uuid: function get_uuid() {
      return keychain.getUUID();
    },

    isArray: function isArray(arg) {
      return utils.isArray(arg);
    },

    get_subscribed_channels: function get_subscribed_channels() {
      return stateStorage.generate_channel_list(true);
    },

    presence_heartbeat: function presence_heartbeat(args) {
      var callback = args['callback'] || function () {};
      var err = args['error'] || function () {};
      var jsonp = jsonp_cb();
      var data = { uuid: keychain.getUUID(), auth: keychain.getAuthKey() };

      var st = JSON.stringify(STATE);
      if (st.length > 2) data['state'] = JSON.stringify(STATE);

      if (PRESENCE_HB > 0 && PRESENCE_HB < 320) data['heartbeat'] = PRESENCE_HB;

      if (jsonp != '0') {
        data['callback'] = jsonp;
      }

      var channels = utils.encode(stateStorage.generate_channel_list(true).join(','));
      var channel_groups = stateStorage.generate_channel_group_list(true).join(',');

      if (!channels) channels = ',';
      if (channel_groups) data['channel-group'] = channel_groups;

      if (config.isInstanceIdEnabled()) {
        data['instanceid'] = keychain.getInstanceId();
      }

      if (config.isRequestIdEnabled()) {
        data['requestid'] = utils.generateUUID();
      }

      xdr({
        callback: jsonp,
        data: networking.prepareParams(data),
        url: [networking.getStandardOrigin(), 'v2', 'presence', 'sub-key', keychain.getSubscribeKey(), 'channel', channels, 'heartbeat'],
        success: function success(response) {
          _responders2.default.callback(response, callback, err);
        },
        fail: function fail(response) {
          _responders2.default.error(response, err);
        }
      });
    },

    stop_timers: function stop_timers() {
      clearTimeout(_poll_timer);
      clearTimeout(_poll_timer2);
      clearTimeout(PRESENCE_HB_TIMEOUT);
    },

    shutdown: function shutdown() {
      SELF['stop_timers']();
      _shutdown && _shutdown();
    },

    // Expose PUBNUB Functions
    xdr: xdr,
    ready: ready,
    db: db,
    uuid: utils.generateUUID,
    map: utils.map,
    each: utils.each,
    'each-channel': each_channel,
    grep: utils.grep,
    offline: function offline() {
      _reset_offline(1, { message: 'Offline. Please check your network settings.' });
    },
    supplant: utils.supplant,
    now: utils.rnow,
    unique: unique,
    updater: utils.updater
  };

  function _poll_online() {
    _is_online() || _reset_offline(1, { error: 'Offline. Please check your network settings.' });
    _poll_timer && clearTimeout(_poll_timer);
    _poll_timer = utils.timeout(_poll_online, SECOND);
  }

  function _poll_online2() {
    if (!TIME_CHECK) return;
    SELF['time'](function (success) {
      detect_time_detla(function () {}, success);
      success || _reset_offline(1, {
        error: 'Heartbeat failed to connect to Pubnub Servers.' + 'Please check your network settings.'
      });
      _poll_timer2 && clearTimeout(_poll_timer2);
      _poll_timer2 = utils.timeout(_poll_online2, KEEPALIVE);
    });
  }

  function _reset_offline(err, msg) {
    SUB_RECEIVER && SUB_RECEIVER(err, msg);
    SUB_RECEIVER = null;

    clearTimeout(_poll_timer);
    clearTimeout(_poll_timer2);
  }

  _poll_timer = utils.timeout(_poll_online, SECOND);
  _poll_timer2 = utils.timeout(_poll_online2, KEEPALIVE);
  PRESENCE_HB_TIMEOUT = utils.timeout(start_presence_heartbeat, (PRESENCE_HB_INTERVAL - 3) * SECOND);

  // Detect Age of Message
  function detect_latency(tt) {
    var adjusted_time = utils.rnow() - TIME_DRIFT;
    return adjusted_time - tt / 10000;
  }

  detect_time_detla();
  function detect_time_detla(cb, time) {
    var stime = utils.rnow();

    time && calculate(time) || SELF['time'](calculate);

    function calculate(time) {
      if (!time) return;
      var ptime = time / 10000;
      var latency = (utils.rnow() - stime) / 2;
      TIME_DRIFT = utils.rnow() - (ptime + latency);
      cb && cb(TIME_DRIFT);
    }
  }

  return SELF;
}

module.exports = {
  PN_API: PN_API,
  unique: unique,
  PNmessage: PNmessage,
  DEF_TIMEOUT: DEF_TIMEOUT,
  timeout: utils.timeout,
  build_url: utils.buildURL,
  each: utils.each,
  uuid: utils.generateUUID,
  URLBIT: defaultConfiguration.URLBIT,
  grep: utils.grep,
  supplant: utils.supplant,
  now: utils.rnow,
  updater: utils.updater,
  map: utils.map
};
//# sourceMappingURL=pubnub-common.js.map