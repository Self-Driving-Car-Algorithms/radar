var MiniEventEmitter = require('miniee'),
    Core = require('../core'),
    Type = Core.Type,
    logging = require('minilog')('radar:server'),
    hostname = require('os').hostname(),
    DefaultEngineIO = require('engine.io'),
    Semver = require('semver'),
    Client = require('../client/client.js');

function Server() {
  this.socketServer = null;
  this.resources = {};
  this.subscriber = null;
  this.subs = {};
}

MiniEventEmitter.mixin(Server);

// Public API

// Attach to a http server
Server.prototype.attach = function(httpServer, configuration) {
  Client.dataTTLSet(configuration.clientDataTTL);
  var finishSetup = this._setup.bind(this, httpServer, configuration);
  setupPersistence(configuration, finishSetup);
};

// Destroy empty resource
Server.prototype.destroyResource = function(name) {
  if (this.resources[name]) {
    this.resources[name].destroy();
  }
  delete this.resources[name];
  delete this.subs[name];
  logging.info('#redis - unsubscribe', name);
  this.subscriber.unsubscribe(name);
};

Server.prototype.terminate = function(done) {
  var self = this;
  Object.keys(this.resources).forEach(function(name) {
    self.destroyResource(name);
  });

  Core.Resources.Presence.sentry.stop();
  this.socketServer.close();
  Core.Persistence.disconnect(done);
};

// Private API

var VERSION_CLIENT_DATASTORE = '0.13.1';

Server.prototype._setup = function(httpServer, configuration) {
  var engine = DefaultEngineIO,
      engineConf;

  configuration = configuration || {};
  this.subscriber = Core.Persistence.pubsub();

  this.subscriber.on('message', this._handlePubSubMessage.bind(this));

  Core.Resources.Presence.sentry.start();
  Core.Resources.Presence.sentry.setMaxListeners(0);
  Core.Resources.Presence.sentry.setHostPort(hostname, configuration.port);

  if (configuration.engineio) {
    engine = configuration.engineio.module;
    engineConf = configuration.engineio.conf;

    this.engineioPath = configuration.engineio.conf ?
                configuration.engineio.conf.path : 'default';
  }

  this.socketServer = engine.attach(httpServer, engineConf);
  this.socketServer.on('connection', this._onSocketConnection.bind(this));

  logging.debug('#server - start ' + new Date().toString());
  this.emit('ready');
};

Server.prototype._onSocketConnection = function(socket) {
  var self = this;
  var oldSend = socket.send;

  // Always send data as json
  socket.send = function(data) {
    logging.info('#socket - sending data', socket.id, data);
    oldSend.call(socket, JSON.stringify(data));
  };

  // Event: socket connected
  logging.info('#socket - connect', socket.id);

  socket.on('message', function(data) {
    self._handleSocketMessage(socket, data);
  });

  socket.on('close', function() {
    // Event: socket disconnected
    logging.info('#socket - disconnect', socket.id);

    Object.keys(self.resources).forEach(function(name) {
      var resource = self.resources[name];
      if (resource.subscribers[socket.id]) {
        resource.unsubscribe(socket, false);
      }
    });
  });
};

// Process a message from persistence (i.e. subscriber)
Server.prototype._handlePubSubMessage = function(name, data) {
  if (this.resources[name]) {
    try {
      data = JSON.parse(data);
    } catch(parseError) {
      logging.error('#redis - Corrupted key value [' + name + ']. ' + parseError.message + ': '+ parseError.stack);
      return;
    }

    this.resources[name].redisIn(data);
  } else {
    // Don't log sentry channel pub messages
    if (name == Core.Presence.Sentry.channel) return;

    logging.warn('#redis - message not handled', name, data);
  }
};

// Process a socket message
Server.prototype._handleSocketMessage = function(socket, data) {
  var message = _parseJSON(data);

  if (!socket) {
    logging.info('_handleSocketMessage: socket is null');
    return;
  }

  // Format check
  if (!message || !message.op || !message.to) {
    logging.warn('#socket.message - rejected', socket.id, data);
    return;
  }

  if (!this._messageAuthorize(message, socket)) {
    return;
  }

  if (!this._clientDataPersist(socket, message)) {
    return;
  }

  this._resourceMessageHandle(socket, message);
};

// Initialize a client, and persist messages where required
Server.prototype._clientDataPersist = function (socket, message) {
  // Sync the client name to the current socket
  if (message.op == 'nameSync') {
    this._clientInit(message);

    socket.send({ op: 'ack', value: message && message.ack });
    return false;
  }
  else {
    var client = Client.get(socket.id);
    if (client && Semver.gte(client.version, VERSION_CLIENT_DATASTORE)) {
      client.dataStore(message);
    }
  }

  return true;
};

// Get a resource, subscribe where required, and handle associated message
Server.prototype._resourceMessageHandle = function (socket, message) {
  var resource = this._resourceGet(message.to);
  if (resource) {
    logging.info('#socket.message - received', socket.id, message,
      (this.resources[message.to] ? 'exists' : 'not instantiated'),
      (this.subs[message.to] ? 'is subscribed' : 'not subscribed')
      );

    this._persistenceSubscribe(resource.name, socket.id);
    resource.handleMessage(socket, message);
    this.emit(message.op, socket, message);
  }
};

// Authorize a socket message
Server.prototype._messageAuthorize =  function (message, socket) {
  var isAuthorized = Core.Auth.authorize(message, socket);
  if (!isAuthorized) {
    logging.warn('#socket.message - auth_invalid', message, socket.id);
    socket.send({
      op: 'err',
      value: 'auth',
      origin: message
    });
  }

  return isAuthorized; 
};

// Get or create resource by name
Server.prototype._resourceGet = function(name) {
  if (!this.resources[name]) {
    var definition = Type.getByExpression(name);

    if (definition && Core.Resources[definition.type]) {
      this.resources[name] = new Core.Resources[definition.type](name, this, definition);
    } else {
      logging.error('#resource - unknown_type', name, definition);
    }
  }
  return this.resources[name];
};

// Subscribe to the persistence pubsub channel for a single resource
Server.prototype._persistenceSubscribe = function (name, id) {
  if (!this.subs[name]) {
    logging.debug('#redis - subscribe', name, id);
    this.subscriber.subscribe(name, function(err) {
      if (err) {
        logging.error('#redis - subscribe failed', name, id, err);
      } else {
        logging.debug('#redis - subscribe successful', name, id);
      }
    });
    this.subs[name] = true;
  }
};

// Initialize the current client
Server.prototype._clientInit = function (initMessage) {
  Client.create(initMessage);
};

function _parseJSON(data) {
  try {
    var message = JSON.parse(data);
    return message;
  } catch(e) { }
  return false;
}


// Transforms Redis URL into persistence configuration object
function setupPersistence(configuration, done) {
  Core.Persistence.setConfig(configuration.persistence);
  Core.Persistence.connect(done);
}

module.exports = Server;
