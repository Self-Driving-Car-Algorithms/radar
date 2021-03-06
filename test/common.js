var http = require('http')
var path = require('path')
var logging = require('minilog')('common')
var formatter = require('./lib/formatter')
var Persistence = require('persistence')
var RadarServer = require('../index').server
var configuration = require('../configurator').load({ persistence: true })
var Sentry = require('../src/core/resources/presence/sentry')
var Client = require('radar_client').constructor
var fork = require('child_process').fork
var Tracker = require('callback_tracker')

Sentry.expiry = 4000
if (process.env.verbose) {
  var Minilog = require('minilog')
  // Configure log output
  Minilog.pipe(Minilog.suggest.deny(/.*/, (process.env.radar_log ? process.env.radar_log : 'debug')))
    .pipe(formatter)
    .pipe(Minilog.backends.nodeConsole.formatColor)
    .pipe(process.stdout)

  require('radar_client')._log.pipe(Minilog.suggest.deny(/.*/, (process.env.radar_log ? process.env.radar_log : 'debug')))
    .pipe(formatter)
    .pipe(Minilog.backends.nodeConsole.formatColor)
    .pipe(process.stdout)
}

http.globalAgent.maxSockets = 10000

module.exports = {
  spawnRadar: function () {
    var radarProcess

    function getListener (action, callbackFn) {
      var listener = function (message) {
        message = JSON.parse(message)
        logging.debug('message received', message, action)
        if (message.action === action) {
          if (callbackFn) callbackFn(message.error)
        }
      }
      return listener
    }

    radarProcess = fork(path.join(__dirname, '/lib/radar.js'))
    radarProcess.sendCommand = function (command, arg, callbackFn) {
      var listener = getListener(command, function (error) {
        logging.debug('removing listener', command)
        radarProcess.removeListener('message', listener)
        if (callbackFn) callbackFn(error)
      })

      radarProcess.on('message', listener)
      radarProcess.send(JSON.stringify({
        action: command,
        arg: configuration
      }))
    }

    process.on('exit', function () {
      if (radarProcess.running) {
        radarProcess.kill()
      }
    })

    radarProcess.running = true
    radarProcess.port = configuration.port
    return radarProcess
  },

  stopRadar: function (radar, done) {
    radar.sendCommand('stop', {}, function () {
      radar.kill()
      radar.running = false
      done()
    })
  },

  restartRadar: function (radar, configuration, clients, callbackFn) {
    var tracker = Tracker.create('server restart, given clients ready', function () {
      if (callbackFn) setTimeout(callbackFn, 5)
    })

    for (var i = 0; i < clients.length; i++) {
      clients[i].once('ready', tracker('client ' + i + ' ready'))
    }

    var serverRestart = tracker('server restart')

    radar.sendCommand('stop', {}, function () {
      radar.sendCommand('start', configuration, serverRestart)
    })
  },

  startPersistence: function (done) {
    Persistence.setConfig(configuration.persistence)
    Persistence.connect(function () {
      Persistence.delWildCard('*', done)
    })
  },
  endPersistence: function (done) {
    Persistence.delWildCard('*', function () {
      Persistence.disconnect(done)
    })
  },
  getClient: function (account, userId, userType, userData, done) {
    var client = new Client().configure({
      userId: userId,
      userType: userType,
      accountName: account,
      port: configuration.port,
      upgrade: false,
      userData: userData
    }).once('ready', done).alloc('test')
    return client
  },
  configuration: configuration,

  // Create an in-process radar server, not a child process.
  createRadarServer: function (done) {
    var notFound = function p404 (req, res) {}
    var httpServer = http.createServer(notFound)

    var radarServer = new RadarServer()
    radarServer.attach(httpServer, configuration)

    if (done) {
      setTimeout(done, 200)
    }

    return radarServer
  }
}
