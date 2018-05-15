require('./util/callbackPromise')(Promise);
const WebSocket = require('isomorphic-ws');
const EventEmitter = require('events');
const hash = require('./util/authenticationHashing');
const Status = require('./Status');
const debug = require('debug')('obs-websocket-js:Socket');
const logAmbiguousError = require('./util/logAmbiguousError');
const camelCaseKeys = require('./util/camelCaseKeys');

class Socket extends EventEmitter {
  constructor() {
    super();
    this._connected = false;
    this._socket = undefined;

    const originalEmit = this.emit;
    this.emit = function () {
      // Log every emit to debug. Could be a bit noisy.
      debug('[emit] %s err: %o data: %o', arguments[0], arguments[1], arguments[2]);
      originalEmit.apply(this, arguments);
    };
  }

  async connect(args = {}, callback) {
    args = args || {};
    const address = args.address || 'localhost:4444';

    if (this._connected) {
      this._socket.close();
    }

    return new Promise(async (resolve, reject) => {
      try {
        await this._connect(address);
        await this._authenticate(args.password);
        resolve();
      } catch (err) {
        this._socket.close();
        this._connected = false;
        logAmbiguousError(debug, 'Connection failed:', err);
        reject(err);
      }
    }).callback(callback);
  }

  /**
   * Opens a WebSocket connection to an obs-websocket server, but does not attempt any authentication.
   *
   * @param {String} address
   * @returns {Promise}
   * @private
   */
  async _connect(address) {
    return new Promise((resolve, reject) => {
      let settled = false;

      debug('Attempting to connect to: %s', address);
      this._socket = new WebSocket('ws://' + address);

      // We only handle the initial connection error.
      // Beyond that, the consumer is responsible for adding their own generic `error` event listener.
      this._socket.onerror = error => {
        if (settled) {
          logAmbiguousError(debug, 'Unknown Socket Error', error);
          this.emit('error', error);
          return;
        }

        settled = true;
        reject(error);
      };

      this._socket.onopen = () => {
        if (settled) {
          return;
        }

        this._connected = true;
        settled = true;

        debug('Connection opened: %s', address);
        this.emit('ConnectionOpened');
        resolve();
      };

      // Looks like this should be bound. We don't technically cancel the connection when the authentication fails.
      this._socket.onclose = () => {
        this._connected = false;
        debug('Connection closed: %s', address);
        this.emit('ConnectionClosed');
      };

      // This handler must be present before we can call _authenticate.
      this._socket.onmessage = msg => {
        // eslint-disable-next-line capitalized-comments
        debug('[OnMessage]: %o', msg);
        const message = camelCaseKeys(JSON.parse(msg.data));
        let err;
        let data;

        if (message.status === 'error') {
          err = message;
        } else {
          data = message;
        }

        // Emit the message with ID if available, otherwise try to find a non-messageId driven event.
        if (message.messageId) {
          this.emit(`obs:internal:message:id-${message.messageId}`, err, data);
        } else if (message.updateType) {
          this.emit(message.updateType, data);
        } else {
          logAmbiguousError(debug, 'Unrecognized Socket Message:', message);
          this.emit('message', message);
        }
      };
    });
  }

  /**
   * Authenticates to an obs-websocket server. Must already have an active connection before calling this method.
   *
   * @param {String} [password='']
   * @returns {Promise}
   * @private
   */
  async _authenticate(password = '') {
    if (!this._connected) {
      throw Status.NOT_CONNECTED;
    }

    const auth = await this.getAuthRequired();

    if (!auth.authRequired) {
      debug('Authentication not Required');
      this.emit('AuthenticationSuccess');
      return Status.AUTH_NOT_REQUIRED;
    }

    try {
      await this.send('Authenticate', {
        auth: hash(auth.salt, auth.challenge, password)
      });
    } catch (e) {
      debug('Authentication Failure %o', e);
      this.emit('AuthenticationFailure');
      throw e;
    }

    debug('Authentication Success');
    this.emit('AuthenticationSuccess');
  }

  /**
   * Close and disconnect the WebSocket connection.
   *
   * @function
   * @category request
   */
  disconnect() {
    debug('Disconnect requested.');
    if (this._socket) {
      this._socket.close();
    }
  }
}

module.exports = Socket;
