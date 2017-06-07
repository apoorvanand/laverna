/**
 * @module models/Signal
 */
import $ from 'jquery';
import _ from 'underscore';
import io from 'socket.io-client';
import Radio from 'backbone.radio';
import deb from 'debug';
import * as openpgp from 'openpgp';

const log = deb('lav:models/Signal');

/**
 * This class handles registration, authentication, and connection to the
 * signagling server.
 *
 * @class
 * @license MPL-2.0
 */
export default class Signal {

    /**
     * Radio channel (models/Signal).
     *
     * @prop {Object}
     */
    get channel() {
        return Radio.channel('models/Signal');
    }

    /**
     * Application configs.
     *
     * @prop {Object}
     */
    get configs() {
        return Radio.request('collections/Configs', 'findConfigs');
    }

    constructor(options = {}) {
        /**
         * Options.
         *
         * @prop {Object}
         * @prop {String} options.server - signaling server URL
         * @prop {String} options.api    - API URL
         */
        this.options     = _.extend({
            server: this.configs.signalServer,
        }, options);
        this.options.api = `${this.options.server}/api`;

        // Start replying to requests
        this.channel.reply({
            connect      : this.connect,
            register     : this.register,
            findUser     : this.findUser,
            sendInvite   : this.sendInvite,
            removeInvite : this.removeInvite,
        }, this);
    }

    /**
     * Find a user by name on the signaling server.
     *
     * @param {String} username
     * @returns {Promise}
     */
    findUser({username}) {
        return $.get(`${this.options.api}/users/name/${username}`)
        .catch(err => {
            if (err.status === 404) {
                return null;
            }

            throw new Error(err);
        });
    }

    /**
     * Register a new user on the signaling server.
     *
     * @param {Object} data
     * @param {String} data.username
     * @param {String} data.publicKey
     * @returns {Promise}
     */
    register(data) {
        return $.post(`${this.options.api}/users`, data);
    }

    /**
     * Connect to the socket server.
     *
     * @todo handle reconnect
     * @returns {Promise} - resolves with socket instance if authenticated on the server
     */
    connect() {
        return this.createDeviceId()
        .then(()  => this.auth())
        .then(res => {
            log('auth result is', res);
            if (!res.success || !res.token) {
                return null;
            }

            return this.connectToSignal(res.token);
        });
    }

    /**
     * Generate the device ID if it wasn't done before.
     *
     * @returns {Promise}
     */
    createDeviceId() {
        if (this.configs.deviceId.length) {
            return Promise.resolve();
        }

        return Radio.request('collections/Configs', 'createDeviceId');
    }

    /**
     * Connect to the signaling socket server.
     *
     * @param {String} token - auth token
     * @returns {Promise}
     */
    connectToSignal(token) {
        log('connecting...', token);
        const {username, deviceId} = this.configs;
        this.token  = token;
        this.socket = io(this.options.server, {
            query: `username=${username}&deviceId=${deviceId}&token=${token}`,
        });

        // Listen to events
        this.socket.on('error', this.onSocketError);
        this.socket.on('invite', _.bind(this.onInvite, this));

        return new Promise(resolve => {
            this.socket.once('connect', () => {
                log('connected...');
                this.channel.trigger('connected');
                resolve({socket: this.socket});
            });
        });
    }

    /**
     * Handle socket errors.
     */
    onSocketError(...args) {
        log('Socket error', args);
    }

    /**
     * Authenticate on the signaling server.
     * The possession of a private key serves as authentication.
     *
     * @link https://tools.ietf.org/html/rfc4252#section-7
     * @returns {Promise} - if auth is successful, it returns an object
     * {success: true, token: 'unique token generated by the server'}
     */
    auth() {
        const key = openpgp.key.readArmored(this.configs.publicKey).keys[0];

        return $.get(`${this.options.api}/token/${this.configs.username}`)
        .then(res       => this.createSignature(res))
        .then(signature => {
            log('signature is', {signature});
            const data = {
                signature,
                fingerprint : key.primaryKey.fingerprint,
                username    : this.configs.username,
            };

            return $.post(`${this.options.api}/auth`, data);
        });
    }

    /**
     * Create auth signature.
     * The signature is created over the following data:
     * 1. Session token
     * 2. User name
     * 3. Public key
     *
     * @param {String} sessionToken
     * @returns {Promise}
     */
    createSignature({sessionToken}) {
        log('session token is', sessionToken);
        const data = JSON.stringify({
            sessionToken,
            msg       : 'SIGNAL_AUTH_REQUEST',
            username  : this.configs.username,
            publicKey : this.configs.publicKey,
        });

        return Radio.request('models/Encryption', 'sign', {data});
    }

    /**
     * Send an invite to a user.
     *
     * @param {String} username
     * @param {String} fingerprint - fingerprint of the user
     * to whom the invite should be sent
     */
    sendInvite({username, fingerprint}) {
        const data = JSON.stringify({
            fingerprint,
            from : this.configs.username,
            to   : username,
        });

        log('sending an invite...');
        return Radio.request('models/Encryption', 'sign', {data})
        .then(signature => {
            this.socket.emit('sendInvite', {username, signature});
        });
    }

    /**
     * Remove a user from pending invites on the server.
     *
     * @param {String} {username}
     * @returns {Promise}
     */
    removeInvite({username}) {
        this.socket.emit('removeInvite', {username});
    }

    /**
     * Received an invite from another user.
     *
     * @see module:collections/module/Users
     * @param {Object} data
     * @param {Object} data.user
     * @param {String} data.signature
     */
    onInvite(data) {
        log('received an invite', data);
        return Radio.request('collections/Users', 'saveInvite', data)
        .catch(err => log('error', err));
    }

}

Radio.once('App', 'init', () => {
    Radio.request('utils/Initializer', 'add', {
        name    : 'App:utils',
        callback: () => new Signal(),
    });
});
